import { asRows } from '@/lib/p13/loose-client';

/** A15 (P1-BLUEPRINT-021): the rows of `sales.p1s_negotiation_queue`, parsed defensively. Pure, so a test can call it. */

export type NegotiationQueueRow = {
  opportunityId: string;
  opportunityName: string;
  leadId: string | null;
  stage: string;
  proposalId: string | null;
  proposalVersion: number | null;
  proposalStatus: string | null;
  totalMinor: number | null;
  discountMinor: number | null;
  policyVersion: string | null;
  rounds: number;
  openObjections: number;
  latestObjectionKind: string | null;
  latestConcern: string | null;
  latestObjectionAt: string | null;
  pendingDiscountDecisions: number;
  approvalState: string | null;
  acceptanceUnclear: boolean;
  roundCap: number | null;
  atRoundCap: boolean;
  nextAction: string;
  lastActivityAt: string | null;
};

export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function parseNegotiationQueue(data: unknown): NegotiationQueueRow[] {
  return asRows(data).map((r) => ({
    opportunityId: String(r.opportunity_id),
    opportunityName: String(r.opportunity_name ?? ''),
    leadId: r.lead_id ? String(r.lead_id) : null,
    stage: String(r.stage ?? ''),
    proposalId: r.proposal_id ? String(r.proposal_id) : null,
    proposalVersion: num(r.proposal_version),
    proposalStatus: r.proposal_status ? String(r.proposal_status) : null,
    totalMinor: num(r.total_minor),
    discountMinor: num(r.discount_minor),
    policyVersion: r.policy_version ? String(r.policy_version) : null,
    rounds: Number(r.rounds) || 0,
    openObjections: Number(r.open_objections) || 0,
    latestObjectionKind: r.latest_objection_kind ? String(r.latest_objection_kind) : null,
    latestConcern: r.latest_concern ? String(r.latest_concern) : null,
    latestObjectionAt: r.latest_objection_at ? String(r.latest_objection_at) : null,
    pendingDiscountDecisions: Number(r.pending_discount_decisions) || 0,
    approvalState: r.approval_state ? String(r.approval_state) : null,
    acceptanceUnclear: r.acceptance_unclear === true,
    roundCap: num(r.round_cap),
    atRoundCap: r.at_round_cap === true,
    nextAction: String(r.next_action ?? ''),
    lastActivityAt: r.last_activity_at ? String(r.last_activity_at) : null,
  }));
}
