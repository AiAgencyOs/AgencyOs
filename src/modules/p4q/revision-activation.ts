import type { createAdminClient } from '@/lib/db/admin';

import { looseSchema } from '@/lib/p13/loose-client';

import { callDoor } from './door';
import { gateDesignerRevision } from './designer-gate';

/**
 * W-P1 / W-O1 / p4ui item 7: the checks a Designer or Prototype revision passes BEFORE any model is asked. (The lineage a revision leaves is recorded where the build record exists: `p4ui_derive_version_meta` by `ui_designer:detailUIVersion` on the drafted event, `p4ui_record_build_revision` by `attachBuiltPrototype`.)
 *
 * Three records already existed and nothing consulted them, so a client's "change this" could reach a model without anyone having decided it was a
 * correction. The order, for a client round, is now:
 *
 *   1. the PM's classification exists (UI: `client_feedback_classifications`; prototype: `p4q_prototype_feedback_classifications`). Without one the work WAITS
 *      (the classifier runs beside it on the same event): a retryable failure, never an assumption that it was a correction.
 *   2. the classification allows a rebuild (CORRECTION / INCLUDED_REVISION). Anything else is settled `not_mine`: clarification, change request, direction
 *      change and rejection are routed to people by the classification itself.
 *   3. the p4ui activation record: `p4ui_request_design_job` (UI) / `p4ui_route_prototype_feedback` (prototype). Its refusals (`classification_required`,
 *      `not_a_design_revision`, `phase_blocked`, `locked`, ...) skip the model; every non-activation leaves a row saying who owns it.
 *
 * An Admin edit and a QA defect have no client classification; they go straight to step 3. Nothing here decides for a human: the doors that need a
 * person still answer `person_required`, and the bridge from the PM's classification into the p4ui record is made ONLY for a route that has no side effect
 * (a rebuild), never for the routes that open blockers or change requests.
 */
type Admin = ReturnType<typeof createAdminClient>;

export type Activation =
  | { go: true; designJobId: string | null }
  | { go: false; wait: boolean; outcome: string; reason: string };

/** Outcomes of `p4ui_request_design_job` that mean "this is not a design job right now": the model is skipped and the job is settled. */
const SKIP_OUTCOMES = new Set(['classification_required', 'not_a_design_revision', 'phase_blocked', 'phase_stopped', 'locked', 'refused', 'not_returned', 'already_designed', 'no_gap_confirmed']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function interpretDesignJobOutcome(outcome: string, refId: string | null, routeTo: string | null): Activation {
  if (outcome === 'requested' || outcome === 'exists') return { go: true, designJobId: refId };
  if (SKIP_OUTCOMES.has(outcome)) return { go: false, wait: false, outcome, reason: `no design job: ${outcome}${routeTo ? ` (${routeTo})` : ''}` };
  return { go: false, wait: true, outcome, reason: `the design-job door answered ${outcome}` };
}

export async function activateDesignerForRevision(
  admin: Admin,
  input: {
    organizationId: string;
    phaseFourId: string;
    priorVersionId: string;
    priorStatus: string;
    source: 'client' | 'admin' | 'qa';
    /** The feedback text the Designer will be given (client words, Admin note or QA findings). */
    feedback: string;
  },
): Promise<Activation> {
  const projects = admin.schema('projects');
  const trigger: 'client_visual_revision' | 'admin_edit' | 'design_qa_defect' = input.source === 'client' ? 'client_visual_revision' : input.source === 'admin' ? 'admin_edit' : 'design_qa_defect';

  if (input.source === 'client') {
    const { data: decision, error: dErr } = await projects
      .from('ui_version_client_decisions')
      .select('id')
      .eq('ui_version_id', input.priorVersionId)
      .eq('organization_id', input.organizationId)
      .eq('decision', 'change_requested')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dErr) return { go: false, wait: true, outcome: 'unreadable', reason: `could not read the client decision: ${dErr.message}` };
    if (!decision) return { go: false, wait: false, outcome: 'no_decision', reason: 'no change_requested decision found for this version' };

    const gate = await gateDesignerRevision(admin, { decisionId: decision.id, priorStatus: input.priorStatus });
    if (!gate.allowed) return { go: false, wait: gate.waiting, outcome: gate.waiting ? 'awaiting_classification' : 'not_a_design_revision', reason: gate.reason };

    // The PM's classification allowed a rebuild; record that route for the p4ui activation record (a design_revision route has no side effect).
    const { data: cls, error: cErr } = await projects.from('client_feedback_classifications').select('classification, reasoning').eq('decision_id', decision.id).maybeSingle();
    if (cErr) return { go: false, wait: true, outcome: 'unreadable', reason: `could not read the classification: ${cErr.message}` };
    if (!cls) return { go: false, wait: true, outcome: 'awaiting_classification', reason: 'the classification is not readable yet' };
    const routed = await callDoor(admin, 'projects', 'p4ui_route_ui_feedback', { p_ui_version_id: input.priorVersionId, p_classification: cls.classification, p_reasoning: cls.reasoning });
    if (!routed.ok) return { go: false, wait: true, outcome: 'route_unavailable', reason: `the feedback-route door did not answer: ${routed.message}` };
    const routeOutcome = routed.row.outcome ?? 'no answer';
    if (routeOutcome !== 'routed' && routeOutcome !== 'already_routed') return { go: false, wait: true, outcome: routeOutcome, reason: `the feedback-route door answered ${routeOutcome}` };
  }

  const requested = await callDoor(admin, 'projects', 'p4ui_request_design_job', {
    p_phase_four_id: input.phaseFourId,
    p_trigger: trigger,
    p_source_ui_version_id: input.priorVersionId,
    p_request: input.feedback.slice(0, 4000),
    p_change_set: [],
    p_evidence_id: null,
  });
  if (!requested.ok) return { go: false, wait: true, outcome: 'door_unavailable', reason: `the design-job door did not answer: ${requested.message}` };
  return interpretDesignJobOutcome(requested.row.outcome ?? 'no answer', str(requested.row.ref_id), str(requested.row.route_to));
}

export type PrototypeRevisionGate =
  | { go: true; origin: 'client' | 'admin' | 'qa' }
  | { go: false; wait: boolean; outcome: string; reason: string };

/**
 * The same three steps for a prototype. For a client round (`deliverable_decided`) the PM's classification of THIS decision must exist and allow a rebuild
 * (`projects.p4q_prototype_revision_allowed`); `p4ui_route_prototype_feedback` then records the route. An Admin edit or a QA defect needs neither.
 */
export async function gatePrototypeRevision(
  admin: Admin,
  input: { organizationId: string; deliverableId: string; source: 'client' | 'admin' | 'qa' },
): Promise<PrototypeRevisionGate> {
  if (input.source !== 'client') return { go: true, origin: input.source };
  const projects = admin.schema('projects');

  const { data: deliverable, error: dErr } = await projects.from('deliverables').select('approval_request_id').eq('id', input.deliverableId).eq('organization_id', input.organizationId).maybeSingle();
  if (dErr) return { go: false, wait: true, outcome: 'unreadable', reason: `the deliverable could not be read: ${dErr.message}` };
  const decisionKey = deliverable?.approval_request_id ?? null;
  if (!decisionKey) return { go: false, wait: false, outcome: 'no_decision', reason: 'the deliverable has no decision to classify' };

  const { data: cls, error: cErr } = await looseSchema(admin as never, 'projects')
    .from('p4q_prototype_feedback_classifications')
    .select('classification, reasoning, routed_to, revision_allowed')
    .eq('deliverable_id', input.deliverableId)
    .eq('decision_key', decisionKey)
    .maybeSingle();
  if (cErr) return { go: false, wait: true, outcome: 'unreadable', reason: `the classification could not be read: ${cErr.message}` };
  const row = cls as { classification: string; reasoning: string; routed_to: string; revision_allowed: boolean } | null;
  if (!row) return { go: false, wait: true, outcome: 'awaiting_classification', reason: 'the PM has not classified this prototype feedback yet; nothing is rebuilt before it is' };

  const allowed = await callDoor(admin, 'projects', 'p4q_prototype_revision_allowed', { p_deliverable_id: input.deliverableId, p_decision_key: decisionKey });
  if (!allowed.ok) return { go: false, wait: true, outcome: 'door_unavailable', reason: `the revision gate did not answer: ${allowed.message}` };
  if (allowed.rows[0] === undefined || (allowed.rows[0] as unknown) !== true) {
    return { go: false, wait: false, outcome: row.routed_to, reason: `${row.classification} is routed to ${row.routed_to}; the prototype is not rebuilt` };
  }

  const routed = await callDoor(admin, 'projects', 'p4ui_route_prototype_feedback', { p_deliverable_id: input.deliverableId, p_classification: row.classification, p_reasoning: row.reasoning });
  if (!routed.ok) return { go: false, wait: true, outcome: 'route_unavailable', reason: `the prototype feedback-route door did not answer: ${routed.message}` };
  const routeOutcome = routed.row.outcome ?? 'no answer';
  if (routeOutcome !== 'routed' && routeOutcome !== 'already_routed') return { go: false, wait: true, outcome: routeOutcome, reason: `the prototype feedback-route door answered ${routeOutcome}` };
  return { go: true, origin: 'client' };
}
