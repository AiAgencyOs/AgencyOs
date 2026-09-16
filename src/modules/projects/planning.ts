import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * The operational blueprint's write surface — Project Planning §4, §8, §9, §15.
 *
 * Thin on purpose. Every rule this plan has to keep lives in the migration,
 * as a constraint or a named refusal from a door, because the rules are about
 * what may be *stored* and the database is the only place that cannot be
 * bypassed. What is here is the translation from a door's outcome into a
 * message a person can act on.
 *
 * **Operational, never technical.** §5 forbids this agent from designing
 * tables, APIs, frameworks or coding tasks, and §6 gives those to the Phase 5
 * Development Planning Agent. Nothing in this file has a shape for them —
 * which is the same reason the schema has no column for them.
 *
 * **Who drafts a plan, and when, is not decided here.** The pre-kickoff
 * readiness gate is its own unit; this is the surface it will call.
 */

async function planningActor(): Promise<Result<true>> {
  const context = await requireInternal();
  // The same capability that governs the project itself. A plan is a statement
  // about how this project runs, so the people who may run it may plan it —
  // no new capability was invented for a new table.
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to change this project’s plan.');
  }
  return ok(true);
}

/** §2, §15 — open the next version. */
export async function draftProjectPlan(input: {
  projectId: string;
  objective?: string;
  changeReason?: string;
}): Promise<Result<{ planId: string; version: number; alreadyDrafting: boolean }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('draft_project_plan', {
    p_project_id: input.projectId,
    p_objective: input.objective,
    p_change_reason: input.changeReason,
  });
  if (error) return err('INTERNAL', 'Could not open a plan.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; plan_id?: string | null; version?: number | null }
    | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'drafted':
      return ok({ planId: row!.plan_id!, version: row!.version ?? 1, alreadyDrafting: false });
    case 'already_drafting':
      return ok({ planId: row!.plan_id!, version: row!.version ?? 1, alreadyDrafting: true });
    case 'no_scope':
      // §4.1's prohibition, reached from the other side: a plan drafted with
      // no approved scope would be a plan of things nobody agreed to.
      return err('CONFLICT', 'This project has no approved scope version to plan from.');
    case 'needs_reason':
      return err('VALIDATION', 'A new version of the plan has to say why it exists.');
    case 'unknown_project':
      return err('NOT_FOUND', 'Project not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to plan this project.');
  }
}

/** §8 — a deliverable, traced to something the client approved. */
export async function addPlanDeliverable(input: {
  planId: string;
  name: string;
  applicablePhase: string;
  readinessCriteria: string;
  evidenceRequired: string;
  scopeItemId?: string;
  proposalItemId?: string;
  ownerRole?: string;
  ambiguityNote?: string;
  position?: number;
}): Promise<Result<{ deliverableId: string }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_plan_deliverable', {
    p_plan_id: input.planId,
    p_name: input.name,
    p_applicable_phase: input.applicablePhase,
    p_readiness_criteria: input.readinessCriteria,
    p_evidence_required: input.evidenceRequired,
    p_scope_item_id: input.scopeItemId,
    p_proposal_item_id: input.proposalItemId,
    p_owner_role: input.ownerRole,
    p_ambiguity_note: input.ambiguityNote,
    p_position: input.position,
  });
  if (error) return err('INTERNAL', 'Could not add the deliverable.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; deliverable_id?: string | null }
    | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'added':
      return ok({ deliverableId: row!.deliverable_id! });
    case 'no_approved_source':
      return err('VALIDATION', 'A deliverable has to come from an approved scope item or quotation line — otherwise it is a feature nobody agreed to.');
    case 'not_draft':
      return err('CONFLICT', 'This plan is live. Draft the next version to change it.');
    case 'unknown_plan':
      return err('NOT_FOUND', 'Plan not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this plan.');
  }
}

/** §9 — a dependency, as an object rather than a sentence in a document. */
export async function addPlanDependency(input: {
  planId: string;
  kind: string;
  description: string;
  neededByPhase: string;
  ownerRole: string;
  windowStart?: string;
  windowEnd?: string;
  timingBasis?: string;
}): Promise<Result<{ dependencyId: string }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_plan_dependency', {
    p_plan_id: input.planId,
    p_kind: input.kind,
    p_description: input.description,
    p_needed_by_phase: input.neededByPhase,
    p_owner_role: input.ownerRole,
    p_window_start: input.windowStart,
    p_window_end: input.windowEnd,
    p_timing_basis: input.timingBasis,
  });
  if (error) return err('INTERNAL', 'Could not add the dependency.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; dependency_id?: string | null }
    | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'added':
      return ok({ dependencyId: row!.dependency_id! });
    case 'dates_need_a_basis':
      return err('VALIDATION', 'Say where the date came from. A window with no basis is a promise nobody can defend.');
    case 'client_items_are_pms':
      return err('VALIDATION', 'Anything asked of the client is the project manager’s to collect.');
    case 'not_draft':
      return err('CONFLICT', 'This plan is live. Draft the next version to change it.');
    case 'unknown_plan':
      return err('NOT_FOUND', 'Plan not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this plan.');
  }
}

/** §4.7 — a risk or an assumption. */
export async function addPlanNote(input: {
  planId: string;
  kind: 'risk' | 'assumption';
  statement: string;
  ownerRole?: string;
  escalationPath?: string;
}): Promise<Result<{ noteId: string }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_plan_note', {
    p_plan_id: input.planId,
    p_kind: input.kind,
    p_statement: input.statement,
    p_owner_role: input.ownerRole,
    p_escalation_path: input.escalationPath,
  });
  if (error) return err('INTERNAL', 'Could not add the note.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; note_id?: string | null }
    | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'added':
      return ok({ noteId: row!.note_id! });
    case 'not_draft':
      return err('CONFLICT', 'This plan is live. Draft the next version to change it.');
    case 'unknown_plan':
      return err('NOT_FOUND', 'Plan not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this plan.');
  }
}

/** §15 — make the draft the live blueprint. */
export async function activateProjectPlan(planId: string): Promise<Result<{ version: number }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('activate_project_plan', { p_plan_id: planId });
  if (error) return err('INTERNAL', 'Could not activate the plan.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; version?: number | null }
    | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'activated':
      return ok({ version: row!.version ?? 1 });
    case 'no_deliverables':
      // §7 requires the register. An empty plan reading `active` would satisfy
      // the pre-kickoff gate while containing nothing.
      return err('CONFLICT', 'A plan with no deliverables cannot go live.');
    case 'not_draft':
      return err('CONFLICT', 'This plan is not a draft.');
    case 'unknown_plan':
      return err('NOT_FOUND', 'Plan not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to activate this plan.');
  }
}
