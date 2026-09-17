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
    case 'open_clarifications':
      // G-257. §10: the Planning Agent never guesses an unclear requirement,
      // and PLAN-I09 validates ambiguity before ProjectPlanReady. A plan that
      // went live carrying an open question would have answered it by
      // omission.
      return err('CONFLICT', 'There are unanswered questions on this plan. Resolve them, or route them to a change request.');
    case 'not_draft':
      return err('CONFLICT', 'This plan is not a draft.');
    case 'unknown_plan':
      return err('NOT_FOUND', 'Plan not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to activate this plan.');
  }
}

/**
 * The clarification loop — Project Planning §10, PLAN-I08.
 *
 * §10 is two sentences that are one rule: the Planning Agent *never guesses an
 * unclear client requirement*, and if the answer turns out to be new work it
 * goes to the change process *instead of silently adding it*. So a question
 * has exactly two honest endings, and there is no function here for a third.
 *
 * **The PM owns the client.** Raising a question is the agent's; asking it,
 * recording what came back, and deciding which ending it has are a person's —
 * which is why only `raiseClarification` is granted to the service role.
 * Nothing here sends anything.
 */

/** §10 — flag an ambiguity instead of guessing at it. */
export async function raiseClarification(input: {
  planId: string;
  question: string;
  impact: string;
  scopeItemId?: string;
  deliverableId?: string;
}): Promise<Result<{ clarificationId: string }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('raise_clarification', {
    p_plan_id: input.planId,
    p_question: input.question,
    p_impact: input.impact,
    p_scope_item_id: input.scopeItemId,
    p_deliverable_id: input.deliverableId,
  });
  if (error) return err('INTERNAL', 'Could not raise the clarification.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; clarification_id?: string | null }
    | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'raised':
      return ok({ clarificationId: row!.clarification_id! });
    case 'no_source':
      return err('VALIDATION', 'Say which scope item or deliverable is unclear — a question with no source is an assertion.');
    case 'not_draft':
      return err('CONFLICT', 'This plan is live. Draft the next version to raise a question against it.');
    case 'unknown_plan':
      return err('NOT_FOUND', 'Plan not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this plan.');
  }
}

/** §10 — a person records that the question has been put to the client. */
export async function markClarificationAsked(clarificationId: string): Promise<Result<{ status: 'asked' }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('mark_clarification_asked', { p_clarification_id: clarificationId });
  if (error) return err('INTERNAL', 'Could not record that the question was asked.');

  switch ((Array.isArray(data) ? data[0] : data)?.outcome ?? 'no answer') {
    case 'asked':
      return ok({ status: 'asked' });
    case 'already_asked':
      return err('CONFLICT', 'This question has already been put to the client.');
    case 'unknown_clarification':
      return err('NOT_FOUND', 'Clarification not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this clarification.');
  }
}

/** §10 — the PM structures the client's response. */
export async function recordClarificationAnswer(input: {
  clarificationId: string;
  answer: string;
  answeredVia?: string;
}): Promise<Result<{ status: 'answered' }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_clarification_answer', {
    p_clarification_id: input.clarificationId,
    p_answer: input.answer,
    p_answered_via: input.answeredVia,
  });
  if (error) return err('INTERNAL', 'Could not record the answer.');

  switch ((Array.isArray(data) ? data[0] : data)?.outcome ?? 'no answer') {
    case 'answered':
      return ok({ status: 'answered' });
    case 'not_asked':
      // An answer to a question nobody asked is a guess wearing a client's
      // voice, which is the thing §10 exists to prevent.
      return err('CONFLICT', 'Record that the question was asked before recording an answer to it.');
    case 'empty_answer':
      return err('VALIDATION', 'An empty answer is not an answer.');
    case 'already_settled':
      return err('CONFLICT', 'This question is already settled.');
    case 'unknown_clarification':
      return err('NOT_FOUND', 'Clarification not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this clarification.');
  }
}

/** §10's first ending — the client answered, and the plan can be re-versioned. */
export async function resolveClarification(clarificationId: string): Promise<Result<{ status: 'resolved' }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('resolve_clarification', { p_clarification_id: clarificationId });
  if (error) return err('INTERNAL', 'Could not resolve the clarification.');

  switch ((Array.isArray(data) ? data[0] : data)?.outcome ?? 'no answer') {
    case 'resolved':
      return ok({ status: 'resolved' });
    case 'no_answer':
      return err('CONFLICT', 'Closing a question with no answer is deciding what the client meant.');
    case 'already_settled':
      return err('CONFLICT', 'This question is already settled.');
    case 'unknown_clarification':
      return err('NOT_FOUND', 'Clarification not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this clarification.');
  }
}

/** §10's second ending — it turned out to be new work, so it is priced and approved. */
export async function routeClarificationToChangeRequest(input: {
  clarificationId: string;
  changeRequestId: string;
}): Promise<Result<{ status: 'routed_to_change_request' }>> {
  const gate = await planningActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('route_clarification_to_change_request', {
    p_clarification_id: input.clarificationId,
    p_change_request_id: input.changeRequestId,
  });
  if (error) return err('INTERNAL', 'Could not route the clarification.');

  switch ((Array.isArray(data) ? data[0] : data)?.outcome ?? 'no answer') {
    case 'routed':
      return ok({ status: 'routed_to_change_request' });
    case 'wrong_project':
      // Named rather than folded into NOT_FOUND: this would price one client's
      // new work onto another client's change request.
      return err('CONFLICT', 'That change request belongs to a different project.');
    case 'already_settled':
      return err('CONFLICT', 'This question is already settled.');
    case 'unknown_change_request':
      return err('NOT_FOUND', 'Change request not found.');
    case 'unknown_clarification':
      return err('NOT_FOUND', 'Clarification not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this clarification.');
  }
}
