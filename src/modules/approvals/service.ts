import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { Json } from '@/lib/db/types';
import { err, ok, type Result } from '@/lib/result';

import {
  decideApprovalSchema,
  requestApprovalSchema,
  upsertPolicySchema,
  violatesMoneyFloor,
  type ApprovalState,
  type DecideApprovalInput,
  type RequestApprovalInput,
  type UpsertPolicyInput,
} from './schema';

/**
 * Writes for the approvals module — its only public surface.
 *
 * Gap G-040, decision ADM-08. This module owns one question: who has to say
 * yes, and did they. It knows nothing about invoices, deliverables or
 * prototypes beyond a subject type and an id, which is what lets one table
 * serve all eight (ARCHITECTURE.md §4.6) instead of thirteen bespoke gates.
 *
 * **It grants nothing.** An approved request does not let anybody issue an
 * invoice they could not already issue — every capability check and RLS policy
 * that stood before this module still stands. The engine records consent; the
 * gates that act on it are the callers', and they arrive with the features
 * that need them.
 *
 * ── why no new capabilities ──────────────────────────────────────────────
 *
 * The capability matrix deliberately gains nothing here, on its own stated
 * principle: a capability mapping to a role set that already exists adds
 * vocabulary without adding control.
 *
 *   Reading the queue is `core.is_internal()` — the same set every internal
 *   read already uses, expressed in the RLS policy rather than twice.
 *
 *   Settling a request is per-request, not per-role: the required role is
 *   snapshotted on the row and checked under a lock by
 *   `approvals.decide_approval`. No static capability can express "whoever
 *   this particular request named", and one that tried would be wider than
 *   the rule — which is D16.
 *
 *   Writing policy is owner-only, which `organization.settings` already
 *   means. It is reused rather than duplicated.
 */

/** What `approvals.request_approval` hands back. */
type RequestRow = {
  outcome: 'requested' | 'already_pending' | 'no_policy' | 'forbidden';
  request_id: string | null;
  state: ApprovalState | null;
  required_role: string | null;
  sla_due_at: string | null;
};

/** What `approvals.decide_approval` hands back. */
type DecisionRow = {
  outcome:
    | 'decided'
    | 'not_found'
    | 'already_decided'
    | 'forbidden'
    | 'no_actor'
    | 'evidence_required'
    | 'invalid_decision';
  request_id: string | null;
  state: ApprovalState | null;
  decided_at: string | null;
};

export type ApprovalRequested = {
  requestId: string;
  state: ApprovalState;
  requiredRole: string;
  slaDueAt: string;
  /** True when this call found the question already asked rather than asking it. */
  alreadyPending: boolean;
};

/**
 * Raise an approval request, or answer with the pending one that exists.
 *
 * Idempotent by construction rather than by convention: two callers racing on
 * one subject hit `approval_requests_open_subject_key`, and the loser is
 * handed the winner's request instead of an error. A job that runs twice, a
 * retried webhook and a double-clicked button all land in the same place —
 * §34 of the directive, which this repository has had to learn twice.
 */
export async function requestApproval(input: RequestApprovalInput): Promise<Result<ApprovalRequested>> {
  const parsed = requestApprovalSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That approval request is not valid.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const { userId, organizationId } = await requireInternal();
  if (!organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  const { data, error } = await supabase.schema('approvals').rpc('request_approval', {
    p_organization_id: organizationId,
    p_subject_type: parsed.data.subjectType,
    p_subject_id: parsed.data.subjectId,
    p_requested_by_type: 'user',
    p_requested_by_id: userId,
    // Omitted rather than nulled: these are DEFAULT NULL arguments, and
    // PostgREST types them optional. Passing an explicit null would type-check
    // as a different call than the one the function declares.
    ...(parsed.data.summary ? { p_summary: parsed.data.summary } : {}),
    ...(parsed.data.payload ? { p_payload: parsed.data.payload as Json } : {}),
    ...(parsed.data.amountMinor !== undefined ? { p_amount_minor: parsed.data.amountMinor } : {}),
    ...(parsed.data.audience ? { p_audience: parsed.data.audience } : {}),
    ...(parsed.data.correlationId ? { p_correlation_id: parsed.data.correlationId } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'requestApproval', detail: error.message }));
    return err('INTERNAL', 'Could not raise the approval request.');
  }

  const settled = (Array.isArray(data) ? data[0] : data) as RequestRow | undefined;
  if (!settled) return err('INTERNAL', 'Could not raise the approval request.');

  if (settled.outcome === 'forbidden') {
    return err('FORBIDDEN', 'That approval belongs to another organization.');
  }

  // Not a default-open, and worth the explicit message: with no policy there
  // is nobody named to answer, so raising the request would create a queue
  // entry that rots. The owner writes a policy, and the caller tries again.
  if (settled.outcome === 'no_policy') {
    return err(
      'CONFLICT',
      `No approval policy covers ${parsed.data.subjectType}. An owner sets one before this can be approved.`,
    );
  }

  if (!settled.request_id || !settled.state || !settled.required_role || !settled.sla_due_at) {
    return err('INTERNAL', 'Could not raise the approval request.');
  }

  return ok({
    requestId: settled.request_id,
    state: settled.state,
    requiredRole: settled.required_role,
    slaDueAt: settled.sla_due_at,
    alreadyPending: settled.outcome === 'already_pending',
  });
}

export type ApprovalDecided = {
  requestId: string;
  state: ApprovalState;
  decidedAt: string;
};

/**
 * Settle a pending request.
 *
 * The role check, the lock and the audit row all live in
 * `approvals.decide_approval`; this function's whole job is to hand it a
 * validated input and turn its outcome into an error a page can render. It
 * deliberately does not pre-check the caller's role: a check here would be a
 * read-then-write against a row somebody else may settle in between, which is
 * the defect this repository has now closed eight times.
 */
export async function decideApproval(input: DecideApprovalInput): Promise<Result<ApprovalDecided>> {
  const parsed = decideApprovalSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That decision is not valid.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  await requireInternal();

  const supabase = await createClient();

  const { data, error } = await supabase.schema('approvals').rpc('decide_approval', {
    p_request_id: parsed.data.requestId,
    p_decision: parsed.data.decision,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
    ...(parsed.data.evidenceRef ? { p_evidence_ref: parsed.data.evidenceRef } : {}),
    ...(parsed.data.clientContactId ? { p_client_contact_id: parsed.data.clientContactId } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'decideApproval', detail: error.message }));
    return err('INTERNAL', 'Could not record the decision.');
  }

  const settled = (Array.isArray(data) ? data[0] : data) as DecisionRow | undefined;
  if (!settled) return err('INTERNAL', 'Could not record the decision.');

  switch (settled.outcome) {
    case 'decided':
      if (!settled.request_id || !settled.state || !settled.decided_at) {
        return err('INTERNAL', 'Could not record the decision.');
      }
      return ok({
        requestId: settled.request_id,
        state: settled.state,
        decidedAt: settled.decided_at,
      });

    case 'not_found':
      return err('NOT_FOUND', 'Approval request not found.');

    // Not an error the caller caused, and not a success either: somebody else
    // answered first. The state is named so the page can show what they said.
    case 'already_decided':
      return err('CONFLICT', `This request was already ${settled.state ?? 'decided'}.`);

    case 'forbidden':
      return err('FORBIDDEN', 'This approval needs a different role.');

    // Reachable only through the service role, which has no identity to
    // attribute a decision to. Directive §29: absence of a response is never
    // approval, and neither is an automation deciding its own work.
    case 'no_actor':
      return err('UNAUTHORIZED', 'A decision needs a signed-in approver.');

    case 'evidence_required':
      return err('VALIDATION', 'Recording a client decision needs the evidence it came from.', {
        details: { evidenceRef: ['Where the client agreed — a WhatsApp message reference, for example.'] },
      });

    case 'invalid_decision':
      return err('VALIDATION', 'That is not a decision this request accepts.');

    default:
      return err('INTERNAL', 'Could not record the decision.');
  }
}

/**
 * Write an approval policy.
 *
 * ADM-08b put policy in data so a threshold changes without a deploy. Two
 * things keep that from becoming a way around the gates it configures: RLS
 * admits only the owner, and `approval_policies_money_floor` refuses a policy
 * that puts a refund below owner or money below ops_admin. The floor is
 * restated here only so a form can say why before submitting — the constraint
 * is the rule.
 */
export async function upsertApprovalPolicy(input: UpsertPolicyInput): Promise<Result<{ id: string }>> {
  const parsed = upsertPolicySchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That policy is not valid.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const { role, organizationId } = await requireInternal();
  if (!organizationId) return err('FORBIDDEN', 'No organization on this session.');
  if (!can(role, 'organization.settings')) {
    return err('FORBIDDEN', 'Only an owner may change approval policy.');
  }

  const floor = violatesMoneyFloor(parsed.data);
  if (floor) return err('VALIDATION', floor);

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('approvals')
    .from('approval_policies')
    .upsert(
      {
        organization_id: organizationId,
        subject_type: parsed.data.subjectType,
        min_amount_minor: parsed.data.minAmountMinor,
        required_role: parsed.data.requiredRole,
        sla_hours: parsed.data.slaHours,
        audience: parsed.data.audience,
        note: parsed.data.note ?? null,
        active: true,
      },
      { onConflict: 'organization_id,subject_type,min_amount_minor' },
    )
    .select('id')
    .single();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'upsertApprovalPolicy', detail: error.message }));
    return err('INTERNAL', 'Could not save the approval policy.');
  }

  // The audit row is written by approval_policies_audit, inside this same
  // statement's transaction — G-079's rule, and the reason there is no
  // recordAudit call here to forget.
  return ok({ id: data.id });
}
