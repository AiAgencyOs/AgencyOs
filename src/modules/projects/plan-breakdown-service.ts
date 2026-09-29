import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { breakDownPlanSchema, type BreakDownPlanInput } from './plan-breakdown-schema';
import { createFeature, createModule, createTask } from './service';

/**
 * "Create modules, features and tasks from the plan" — SCR-040.
 *
 * The operational plan names deliverables; the development tab holds
 * modules → features → tasks; and until now the second was typed in by hand
 * from the first. This walks the plan's deliverables through the three
 * doors that already exist (`createModule`, `createFeature`, `createTask`),
 * one deliverable at a time, and reports what each door said.
 *
 * ── one deliverable, one module, one feature, one task ──────────────────
 *
 * The mapping is deliberately flat. A deliverable becomes a module of the
 * same name (its readiness criteria as the description), one feature
 * inside it (the evidence required), and one task to produce that evidence.
 * Inventing a finer breakdown here would be the Development Planning
 * Agent's job (Doc 15), and a person can split what this made.
 *
 * ── not a transaction, and it says so ───────────────────────────────────
 *
 * Three Server-side inserts per deliverable through three doors, each with
 * its own capability check and RLS. A refusal midway leaves what was made;
 * the report names every refusal so the caller can see exactly which
 * deliverables have a module and which do not. Running it again skips a
 * deliverable whose module already exists (matched by name on this
 * project), so the door is safe to press twice.
 */

export type BreakDownReport = {
  planVersion: number;
  created: { modules: number; features: number; tasks: number };
  skipped: string[];
  refusals: string[];
};

export async function breakDownPlan(input: BreakDownPlanInput): Promise<Result<BreakDownReport>> {
  const parsed = breakDownPlanSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That plan could not be validated.');

  const context = await requireInternal();
  // The three doors check again; this keeps a reader off a button all three
  // would refuse.
  if (!can(context, 'milestone.write') || !can(context, 'task.write')) {
    return err('FORBIDDEN', 'You do not have permission to break this plan down.');
  }

  const supabase = await createClient();

  const { data: plan, error: planError } = await supabase
    .schema('projects')
    .from('project_plans')
    .select('id, version, status, project_id')
    .eq('id', parsed.data.planId)
    .eq('project_id', parsed.data.projectId)
    .maybeSingle();
  if (planError) return err('INTERNAL', 'Could not read the plan.');
  if (!plan) return err('NOT_FOUND', 'That plan does not belong to this project.');
  if (plan.status === 'superseded') {
    return err('CONFLICT', `Plan v${plan.version} is superseded. Break down the version that replaced it.`);
  }

  const [{ data: deliverables, error: deliverablesError }, { data: modules, error: modulesError }] = await Promise.all([
    supabase
      .schema('projects')
      .from('plan_deliverables')
      .select('id, name, readiness_criteria, evidence_required, position')
      .eq('plan_id', plan.id)
      .order('position', { ascending: true }),
    supabase.schema('projects').from('modules').select('name').eq('project_id', plan.project_id),
  ]);
  if (deliverablesError) return err('INTERNAL', 'Could not read the plan deliverables.');
  if (modulesError) return err('INTERNAL', 'Could not read the existing modules.');
  if (!deliverables || deliverables.length === 0) {
    return err('VALIDATION', 'The plan has no deliverables to break down.');
  }

  const existing = new Set((modules ?? []).map((m) => m.name.trim().toLowerCase()));
  const report: BreakDownReport = { planVersion: plan.version, created: { modules: 0, features: 0, tasks: 0 }, skipped: [], refusals: [] };

  for (const d of deliverables) {
    if (existing.has(d.name.trim().toLowerCase())) {
      report.skipped.push(d.name);
      continue;
    }

    const module = await createModule({
      projectId: plan.project_id,
      name: d.name,
      description: `Ready when: ${d.readiness_criteria}`,
    });
    if (!module.ok) {
      report.refusals.push(`${d.name}: module — ${module.error.message}`);
      continue;
    }
    report.created.modules += 1;
    existing.add(d.name.trim().toLowerCase());

    const feature = await createFeature({
      projectId: plan.project_id,
      moduleId: module.data.moduleId,
      name: d.name,
      description: `Evidence required: ${d.evidence_required}`,
    });
    if (!feature.ok) {
      report.refusals.push(`${d.name}: feature — ${feature.error.message}`);
      continue;
    }
    report.created.features += 1;

    const task = await createTask({
      projectId: plan.project_id,
      moduleId: module.data.moduleId,
      featureId: feature.data.featureId,
      title: `Deliver ${d.name}`,
      description: `Ready when: ${d.readiness_criteria}\nEvidence: ${d.evidence_required}`,
    });
    if (!task.ok) {
      report.refusals.push(`${d.name}: task — ${task.error.message}`);
      continue;
    }
    report.created.tasks += 1;
  }

  return ok(report);
}
