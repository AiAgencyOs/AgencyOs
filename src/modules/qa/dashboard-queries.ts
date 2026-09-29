import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { Defect } from './types';

/**
 * What the QA dashboard and a project's QA tab could not yet say —
 * SCR-044 to SCR-048.
 *
 * Every figure here is a count over rows the module already writes:
 * `qa.test_plan_items` (category × project — the coverage matrix),
 * `qa.defects` in `fixed` (the retest queue; Doc 14: a developer's fix is
 * not closed until QA verifies it), `projects.production_ready_at` (the
 * readiness column), `qa.test_runs` with the tester and the time, and the
 * audit trail the `record_row_change` trigger keeps on defects
 * (`defect.open` on an UPDATE is a reopen — the same bug still wrong, Doc
 * 14's `fixed → open`). Nothing is re-derived from a rule the database
 * holds; the gates stay `project_quality`'s and `release_gates`'s.
 */

export type CoverageMatrix = {
  categories: string[];
  rows: {
    projectId: string;
    projectName: string;
    scopeVersion: number | null;
    counts: Record<string, number>;
    total: number;
    productionReadyAt: string | null;
    /** `fixed` defects awaiting verification on this project. */
    awaitingRetest: number;
    openBlocking: number;
  }[];
};

export async function readCoverageMatrix(): Promise<CoverageMatrix> {
  const supabase = await createClient();

  const [projects, plans, items, defects] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name, production_ready_at').is('deleted_at', null).order('name', { ascending: true }),
    supabase.schema('qa').from('test_plans').select('id, project_id, scope_version_id, created_at').order('created_at', { ascending: false }),
    supabase.schema('qa').from('test_plan_items').select('plan_id, category'),
    supabase.schema('qa').from('defects').select('project_id, status, severity').in('status', ['open', 'fixed']),
  ]);
  if (projects.error) unreadable('readCoverageMatrix.projects', projects.error);
  if (plans.error) unreadable('readCoverageMatrix.plans', plans.error);
  if (items.error) unreadable('readCoverageMatrix.items', items.error);
  if (defects.error) unreadable('readCoverageMatrix.defects', defects.error);

  // The newest plan per project is "the" plan, the same rule `readTestPlan` uses.
  const planByProject = new Map<string, { id: string; scopeVersionId: string }>();
  for (const p of plans.data ?? []) {
    if (!planByProject.has(p.project_id)) planByProject.set(p.project_id, { id: p.id, scopeVersionId: p.scope_version_id });
  }
  const scopeIds = [...new Set([...planByProject.values()].map((p) => p.scopeVersionId))];
  const scopeNumber = new Map<string, number>();
  if (scopeIds.length > 0) {
    const { data, error } = await supabase.schema('projects').from('scope_versions').select('id, version').in('id', scopeIds);
    if (error) unreadable('readCoverageMatrix.scopeVersions', error);
    for (const v of data ?? []) scopeNumber.set(v.id, v.version);
  }

  const countsByPlan = new Map<string, Record<string, number>>();
  const categories = new Set<string>();
  for (const i of items.data ?? []) {
    categories.add(i.category);
    const counts = countsByPlan.get(i.plan_id) ?? {};
    counts[i.category] = (counts[i.category] ?? 0) + 1;
    countsByPlan.set(i.plan_id, counts);
  }

  const retestByProject = new Map<string, number>();
  const blockingByProject = new Map<string, number>();
  for (const d of defects.data ?? []) {
    if (d.status === 'fixed') retestByProject.set(d.project_id, (retestByProject.get(d.project_id) ?? 0) + 1);
    if (d.status === 'open' && (d.severity === 'blocker' || d.severity === 'major')) {
      blockingByProject.set(d.project_id, (blockingByProject.get(d.project_id) ?? 0) + 1);
    }
  }

  return {
    categories: [...categories].sort(),
    rows: (projects.data ?? []).map((p) => {
      const plan = planByProject.get(p.id);
      const counts = plan ? (countsByPlan.get(plan.id) ?? {}) : {};
      return {
        projectId: p.id,
        projectName: p.name,
        scopeVersion: plan ? (scopeNumber.get(plan.scopeVersionId) ?? null) : null,
        counts,
        total: Object.values(counts).reduce((n, c) => n + c, 0),
        productionReadyAt: p.production_ready_at,
        awaitingRetest: retestByProject.get(p.id) ?? 0,
        openBlocking: blockingByProject.get(p.id) ?? 0,
      };
    }),
  };
}

export type RetestDefect = Defect & { projectId: string; projectName: string; assignee_id: string | null };

/** Every `fixed` defect across every project, oldest fix first — the retest queue. */
export async function listRetestQueue(limit = 200): Promise<RetestDefect[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('qa')
    .from('defects')
    .select(
      'id, severity, status, title, reproduction, expected, actual, environment, evidence_url, resolution, deliverable_id, verified_at, created_at, updated_at, project_id, assignee_id, task_id, run_id',
    )
    .eq('status', 'fixed')
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) unreadable('listRetestQueue.defects', error);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((d) => d.project_id))];
  const { data: projects, error: projectsError } = await supabase.schema('projects').from('projects').select('id, name').in('id', projectIds);
  if (projectsError) unreadable('listRetestQueue.projects', projectsError);
  const nameById = new Map((projects ?? []).map((p) => [p.id, p.name]));

  return rows.map((d) => ({ ...d, projectId: d.project_id, projectName: nameById.get(d.project_id) ?? 'Unknown project' }));
}

export type TestRunDetail = {
  id: string;
  deliverableId: string;
  suite: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  evidenceUrl: string | null;
  executedAt: string;
  recordedAt: string;
  tester: { kind: 'person'; name: string } | { kind: 'agent'; key: string } | null;
};

/** Runs with who ran them and when — SCR-046's tester and timing on the row. */
export async function listTestRunDetails(projectId: string, limit = 100): Promise<TestRunDetail[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('id, deliverable_id, suite, total, passed, failed, skipped, evidence_url, executed_at, created_at, executed_by, executed_by_agent')
    .eq('project_id', projectId)
    .order('executed_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listTestRunDetails', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.executed_by).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: members, error: membersError } = await supabase
      .schema('core')
      .from('memberships')
      .select('user_id, users:user_id(full_name, email)')
      .in('user_id', userIds);
    if (membersError) unreadable('listTestRunDetails.members', membersError);
    for (const m of (members ?? []) as { user_id: string; users: { full_name: string | null; email: string } | null }[]) {
      nameById.set(m.user_id, m.users?.full_name ?? m.users?.email ?? 'Unknown');
    }
  }

  return rows.map((r) => ({
    id: r.id,
    deliverableId: r.deliverable_id,
    suite: r.suite,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    evidenceUrl: r.evidence_url,
    executedAt: r.executed_at,
    recordedAt: r.created_at,
    tester: r.executed_by_agent
      ? { kind: 'agent', key: r.executed_by_agent }
      : r.executed_by
        ? { kind: 'person', name: nameById.get(r.executed_by) ?? 'Unknown' }
        : null,
  }));
}

export type TestPlanVersion = { id: string; scopeVersionId: string; scopeVersion: number | null; scopeStatus: string | null; items: number; createdAt: string; draftedByAgent: string | null };

/** Every test plan ever drafted on a project, one per scope baseline — SCR-045's versions. */
export async function listTestPlanVersions(projectId: string): Promise<TestPlanVersion[]> {
  const supabase = await createClient();

  const { data: plans, error: plansError } = await supabase
    .schema('qa')
    .from('test_plans')
    .select('id, scope_version_id, created_at, drafted_by_agent')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (plansError) unreadable('listTestPlanVersions.plans', plansError);

  const rows = plans ?? [];
  if (rows.length === 0) return [];

  const [versions, items] = await Promise.all([
    supabase
      .schema('projects')
      .from('scope_versions')
      .select('id, version, status')
      .in(
        'id',
        rows.map((p) => p.scope_version_id),
      ),
    supabase
      .schema('qa')
      .from('test_plan_items')
      .select('plan_id')
      .in(
        'plan_id',
        rows.map((p) => p.id),
      ),
  ]);
  if (versions.error) unreadable('listTestPlanVersions.versions', versions.error);
  if (items.error) unreadable('listTestPlanVersions.items', items.error);

  const version = new Map((versions.data ?? []).map((v) => [v.id, v]));
  const count = new Map<string, number>();
  for (const i of items.data ?? []) count.set(i.plan_id, (count.get(i.plan_id) ?? 0) + 1);

  return rows.map((p) => ({
    id: p.id,
    scopeVersionId: p.scope_version_id,
    scopeVersion: version.get(p.scope_version_id)?.version ?? null,
    scopeStatus: version.get(p.scope_version_id)?.status ?? null,
    items: count.get(p.id) ?? 0,
    createdAt: p.created_at,
    draftedByAgent: p.drafted_by_agent,
  }));
}

export type DefectHistoryEntry = { defectId: string; action: string; actorType: string | null; createdAt: string };

/**
 * The fix / retest trail of a project's defects, from the audit log the
 * trigger writes: `defect.raised`, `defect.fixed`, `defect.open` (a reopen),
 * `defect.verified`, `defect.wontfix`. Read once for every defect on the
 * project rather than once per defect.
 */
export async function readDefectHistory(defectIds: readonly string[]): Promise<Map<string, DefectHistoryEntry[]>> {
  const out = new Map<string, DefectHistoryEntry[]>();
  if (defectIds.length === 0) return out;
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('audit')
    .from('audit_log')
    .select('subject_id, action, actor_type, created_at')
    .eq('subject_type', 'defect')
    .in('subject_id', [...defectIds])
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) unreadable('readDefectHistory', error);

  for (const row of data ?? []) {
    if (!row.subject_id) continue;
    const list = out.get(row.subject_id) ?? [];
    list.push({ defectId: row.subject_id, action: row.action, actorType: row.actor_type, createdAt: row.created_at });
    out.set(row.subject_id, list);
  }
  return out;
}

export type QaEvidence = {
  runs: (TestRunDetail & { deliverableTitle: string; deliverableVersion: number })[];
  defects: (Defect & { assigneeId: string | null })[];
};

/** Runs and defects for one project, for the evidence-summary export. */
export async function readQaEvidence(projectId: string): Promise<QaEvidence> {
  const supabase = await createClient();

  const [runs, defects, deliverables] = await Promise.all([
    listTestRunDetails(projectId, 1000),
    supabase
      .schema('qa')
      .from('defects')
      .select('id, severity, status, title, reproduction, expected, actual, environment, evidence_url, resolution, deliverable_id, verified_at, created_at, assignee_id, task_id, run_id')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    supabase.schema('projects').from('deliverables').select('id, title, version').eq('project_id', projectId),
  ]);
  if (defects.error) unreadable('readQaEvidence.defects', defects.error);
  if (deliverables.error) unreadable('readQaEvidence.deliverables', deliverables.error);

  const deliverable = new Map((deliverables.data ?? []).map((d) => [d.id, d]));
  return {
    runs: runs.map((r) => ({
      ...r,
      deliverableTitle: deliverable.get(r.deliverableId)?.title ?? 'unknown build',
      deliverableVersion: deliverable.get(r.deliverableId)?.version ?? 0,
    })),
    defects: (defects.data ?? []).map((d) => ({ ...d, assigneeId: d.assignee_id })),
  };
}
