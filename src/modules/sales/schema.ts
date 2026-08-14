import { z } from 'zod';

/** Same vocabulary as the sales.opportunities stage CHECK. */
export const OPPORTUNITY_STAGES = [
  'discovery',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

/**
 * Legal stage moves.
 *
 * `won` is terminal — the deal converts into a project from there. `lost`
 * reopens to discovery, because a revived deal starts its cycle again rather
 * than resuming mid-negotiation.
 */
export const OPPORTUNITY_TRANSITIONS: Record<OpportunityStage, readonly OpportunityStage[]> = {
  discovery: ['proposal', 'lost'],
  proposal: ['negotiation', 'won', 'lost'],
  negotiation: ['won', 'lost'],
  won: [],
  lost: ['discovery'],
};

/**
 * Same vocabulary as the sales.proposals status CHECK.
 *
 * G-011, ADM-07. `superseded` joins the six the table shipped with, for
 * Document 09 §16: V2 is generated and V1 remains historical.
 */
export const PROPOSAL_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'accepted',
  'rejected',
  'superseded',
  // G-111, ADM-71. Sent, and its validity date passed unanswered. Distinct
  // from `rejected`, which is an answer, and from `superseded`, which is a
  // replacement — conflating any of the three would lose why the row ended.
  //
  // Deliberately NOT in LIVE_PROPOSAL_STATUSES below: that set means "still on
  // its way to an answer", and a lapsed quote is not. It therefore leaves the
  // live set and frees the deal for a new quotation without superseding
  // anything, which follows from the index's own rationale rather than from a
  // separate decision.
  'lapsed',
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * Legal moves, mirroring what the Postgres functions actually admit.
 *
 * This map is documentation and a rendering aid — never an authorisation. The
 * transitions are enforced in `sales.draft_proposal`, `submit_proposal`,
 * `sync_proposal_decision`, `send_proposal` and `record_proposal_response`,
 * each under the row's own lock, because two people acting on one quote is
 * exactly the race SECURITY.md says belongs in the database.
 *
 * `pending_approval → draft` is the owner refusing: staff revise and resubmit,
 * and what was refused survives in the approval request's payload snapshot.
 * Every live state may be superseded, because drafting the next version is
 * always available. `accepted`, `rejected` and `superseded` are terminal.
 *
 * `lapsed` — G-111, ADM-71 — is what `sent` becomes when its validity date
 * passes unanswered. Its two exits are ADM-78's, and the shortness of that
 * list is the decision:
 *
 *   `lapsed → rejected`    the client may still decline (ADM-77). The validity
 *                          period bounds what may be *accepted*; it never took
 *                          away the right to answer, and persisting the lapse
 *                          must not remove it as a side effect.
 *   `lapsed → superseded`  a new version replaces it.
 *
 * **Never extended and never revived.** Both would mean editing a validity
 * date that has already passed, and a date that moves was never a commitment —
 * the record would then disagree with what the client was actually told. To
 * re-offer, draft the next version: that already works, leaves the original
 * intact as evidence, and is auditable.
 */
export const PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  draft: ['pending_approval', 'superseded'],
  pending_approval: ['approved', 'draft', 'superseded'],
  approved: ['sent', 'superseded'],
  sent: ['accepted', 'rejected', 'superseded', 'lapsed'],
  lapsed: ['rejected', 'superseded'],
  accepted: [],
  rejected: [],
  superseded: [],
};

/** The states that count as live — at most one per deal (§16). */
export const LIVE_PROPOSAL_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
] as const satisfies readonly ProposalStatus[];

export function isLiveProposal(status: ProposalStatus): boolean {
  return (LIVE_PROPOSAL_STATUSES as readonly ProposalStatus[]).includes(status);
}

/**
 * Whether a quote may still be accepted today.
 *
 * §15's validity period. Mirrors the check in `record_proposal_response`,
 * which is the one that decides — this exists so a page can grey a button
 * rather than offer an action the database will refuse.
 */
export function hasLapsed(validUntil: string | null, today = new Date()): boolean {
  if (!validUntil) return false;
  return validUntil < today.toISOString().slice(0, 10);
}

export const draftProposalSchema = z.object({
  opportunityId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(20_000).optional(),
  /** §15's validity period, as a date the drafter picks. */
  validUntil: z.iso.date().optional(),
  /** §12: the confirmed requirement version this price was built against. */
  requirementVersionId: z.uuid().optional(),
});

export const addProposalItemSchema = z.object({
  proposalId: z.uuid(),
  description: z.string().trim().min(1).max(500),
  /** numeric(12,2) in the table; two decimals is what it can hold. */
  quantity: z.number().positive().max(1_000_000),
  unitPriceMinor: z.number().int().nonnegative().max(1_000_000_000_000),
});

export const setProposalPricingSchema = z.object({
  proposalId: z.uuid(),
  discountMinor: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
  taxMinor: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
});

export const submitProposalSchema = z.object({
  proposalId: z.uuid(),
  summary: z.string().trim().max(500).optional(),
});

export const sendProposalSchema = z.object({
  proposalId: z.uuid(),
  conversationId: z.uuid().optional(),
  /** §18: the provider's reference for the message that carried it. */
  messageRef: z.string().trim().max(200).optional(),
});

export const recordProposalResponseSchema = z.object({
  proposalId: z.uuid(),
  response: z.enum(['accepted', 'rejected']),
  contactId: z.uuid().optional(),
  note: z.string().trim().max(2000).optional(),
});

/**
 * The stages that settle a deal — G-088.
 *
 * Defined once here and used by every read that asks "does this lead already
 * have a deal?", because the answer must agree with
 * `opportunities_open_lead_key`, whose predicate is exactly
 * `stage not in ('won', 'lost')`. The index is the authority; this mirrors it
 * so the application does not have to spell the same rule out at each call
 * site, and a test asserts the two agree — the same arrangement
 * `LIVE_PROPOSAL_STATUSES` has with `proposals_live_version_key`.
 *
 * ADM-05 and ADM-42: one lead per person forever, and a returning client gets
 * a **new deal on their existing lead**. A settled deal must therefore not
 * stand in the way of the next one.
 */
export const SETTLED_OPPORTUNITY_STAGES = ['won', 'lost'] as const satisfies readonly OpportunityStage[];

/** True when a deal is still in play, and so blocks a second one on its lead. */
export function isOpenOpportunity(stage: OpportunityStage): boolean {
  return !(SETTLED_OPPORTUNITY_STAGES as readonly OpportunityStage[]).includes(stage);
}

export const createOpportunitySchema = z.object({
  leadId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  /** Deal value in the organization's minor units. */
  valueMinor: z.number().int().nonnegative().max(1_000_000_000_000).default(0),
  expectedCloseOn: z.iso.date().optional(),
});

export const setOpportunityStageSchema = z.object({
  opportunityId: z.uuid(),
  stage: z.enum(OPPORTUNITY_STAGES),
  /** Required when losing a deal. */
  lostReason: z.string().trim().max(500).optional(),
});

/**
 * Correcting an open deal's terms — G-092, ADM-43.
 *
 * Every field optional, because the function treats a null as "leave alone"
 * rather than "set to null": correcting a price must not clear a name.
 */
export const setOpportunityTermsSchema = z
  .object({
    opportunityId: z.uuid(),
    valueMinor: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    expectedCloseOn: z.iso.date().optional(),
  })
  .refine(
    (v) => v.valueMinor !== undefined || v.name !== undefined || v.expectedCloseOn !== undefined,
    { message: 'Nothing to change.' },
  );

export const convertToProjectSchema = z.object({
  opportunityId: z.uuid(),
  projectName: z.string().trim().min(1).max(200),
  /**
   * Only used when the opportunity has no client account yet. Defaults to the
   * opportunity name so a conversion never blocks on naming.
   */
  clientAccountName: z.string().trim().min(1).max(200).optional(),
});

export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;
export type SetOpportunityStageInput = z.infer<typeof setOpportunityStageSchema>;
export type ConvertToProjectInput = z.infer<typeof convertToProjectSchema>;
export type SetOpportunityTermsInput = z.infer<typeof setOpportunityTermsSchema>;

export type DraftProposalInput = z.infer<typeof draftProposalSchema>;
export type AddProposalItemInput = z.infer<typeof addProposalItemSchema>;
export type SetProposalPricingInput = z.infer<typeof setProposalPricingSchema>;
export type SubmitProposalInput = z.infer<typeof submitProposalSchema>;
export type SendProposalInput = z.infer<typeof sendProposalSchema>;
export type RecordProposalResponseInput = z.infer<typeof recordProposalResponseSchema>;
