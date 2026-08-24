import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';

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

/**
 * Why a deal was lost, from Document 09 §25's own list.
 *
 * A closed vocabulary because §37 asks for a *"lost reason distribution"* and
 * §30 for *"top lost reasons"* — neither is possible from prose. Ten deals
 * lost for one cause, described ten ways, group into ten rows of one.
 *
 * `other` is §25's own eleventh, not a hole: a cause nobody foresaw is a real
 * outcome, and forcing it into the nearest of the ten would be worse than
 * counting it as unclassified.
 */
export const LOST_CATEGORIES = [
  'price_too_high',
  'no_budget',
  'chose_competitor',
  'project_postponed',
  'no_response',
  'not_a_fit',
  'requirements_changed',
  'trust_not_established',
  'timeline_mismatch',
  'client_cancelled',
  'other',
] as const;

export type LostCategory = (typeof LOST_CATEGORIES)[number];

/** How each reads on a screen. The stored value is the tag, never this. */
export const LOST_CATEGORY_LABELS: Record<LostCategory, string> = {
  price_too_high: 'Price too high',
  no_budget: 'No budget',
  chose_competitor: 'Chose a competitor',
  project_postponed: 'Project postponed',
  no_response: 'No response',
  not_a_fit: 'Not a fit',
  requirements_changed: 'Requirements changed',
  trust_not_established: 'Trust not established',
  timeline_mismatch: 'Timeline mismatch',
  client_cancelled: 'Client cancelled',
  other: 'Other',
};

export const setOpportunityStageSchema = z.object({
  opportunityId: z.uuid(),
  stage: z.enum(OPPORTUNITY_STAGES),
  /**
   * Both required when losing a deal, and both kept.
   *
   * The category is what a report groups by; the sentence is what a person
   * reads. Replacing the words with a dropdown would lose the only part of a
   * lost deal anybody learns from — and a dropdown alone tells you eleven
   * deals were "price too high" without telling you that four of them named
   * the same competitor.
   */
  lostReason: z.string().trim().max(500).optional(),
  lostCategory: z.enum(LOST_CATEGORIES).optional(),
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

/**
 * Document 09 §19's four objection kinds, and no fifth.
 *
 * Mirrors the CHECK in
 * `20260822230000_an_objection_is_recorded_not_answered`.
 */
export const OBJECTION_KINDS = ['price', 'trust', 'timeline', 'feature'] as const;
export type ObjectionKind = (typeof OBJECTION_KINDS)[number];

/** How an objection ended. A person's word, never an agent's. */
export const OBJECTION_OUTCOMES = [
  'resolved',
  'conceded',
  'escalated',
  'withdrawn',
  'lost',
] as const;
export type ObjectionOutcome = (typeof OBJECTION_OUTCOMES)[number];

/**
 * What the sales agent may say about an objection.
 *
 * **Which of §19's four it is, and the words it was raised in. That is all.**
 *
 * §19 asks the CRM to store five things — type, exact concern, response,
 * outcome, next action. This schema can express the first two and cannot
 * express the other three, and the reason is §13's own definition of what a
 * response is: *"Use approved trust-building evidence… Offer only approved
 * low-advance/no-advance structures… Request Admin approval for exceptions…
 * Never make unsupported guarantees."*
 *
 * Every one of those is a commitment to a client — ADM-61 §3's `client_facing`,
 * and for the payment structures §3's `money` too. An agent with a `response`
 * field would be an agent recording a promise nobody made.
 *
 * And §21's nine negotiation limits are Admin-configurable and unconfigured,
 * so there is no discount here, no amount, no floor and no cap. The round
 * number counts; it stops nothing.
 */
export const objectionReadingSchema = z
  .object({
    kind: z.enum(OBJECTION_KINDS),
    concern: z
      .string()
      .trim()
      .min(1, "Quote the client's own words")
      .max(600),
  })
  .strict();

export type ObjectionReading = z.infer<typeof objectionReadingSchema>;

export function objectionReadingJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(objectionReadingSchema)) as Record<string, unknown>;
}

/**
 * What the sales agent may write onto a quotation — Doc 09 §15, and since
 * ADM-96 that includes the price it PROPOSES.
 *
 * The shape held no price field until the owner's grant ("agent sab kuch kre
 * mai bs pdf approve changes karo") moved the human act from typing the
 * number to deciding it: `priceRupees` is a proposal to the OWNER, grounded
 * in the agency's own corpus, and nothing reaches a client until they
 * approve (ADM-07 — the approval engine is now the human gate;
 * `sales.refuse_priced_by_nobody` was retired with it, migration
 * 20260824120000).
 *
 * Still no timeline, discount, or validity date: §15 lists all three among a
 * quote's outputs and every one is a commitment the decider owns. Validity is
 * stamped by the workflow in code (the corpus modal), never asked of a model
 * that cannot know today's date.
 */
export const quotationScopeSchema = z
  .object({
    /** A title a person would recognise the deal by, not a restatement of it. */
    title: z.string().trim().min(3).max(120),
    /**
     * The project as understood — the client's core loop, in their words,
     * from the requirements (G-165, Master System §3). Two to four
     * sentences; the KisanShala benchmark's opening move.
     */
    understanding: z.string().trim().min(30).max(700),
    /**
     * The lines. Each is a piece of work, in the client's own vocabulary where
     * the transcript gave one — Doc 09 §25 of the owner's brief: if they call
     * it a delivery app, it is a delivery app.
     */
    items: z
      .array(
        z
          .object({
            description: z.string().trim().min(3).max(300),
            /**
             * The proposed price for this line, in WHOLE RUPEES — ADM-96.
             *
             * Rupees rather than minor units on purpose: the model reasons in
             * the figures the corpus uses, and the workflow multiplies by 100
             * at the write, so a slipped zero cannot silently 100× a line.
             * Zero is legal for a genuinely-included line (the corpus prices
             * "iOS via the same Flutter build" at +₹0); the refine below
             * refuses a quotation that is zero THROUGHOUT, because
             * `submit_proposal` would answer `no_amount` and the draft would
             * strand. The ceiling is sanity, not policy — well above the
             * corpus's ₹4,75,000 standalone ceiling, far below a mistake.
             */
            priceRupees: z.number().int().min(0).max(2_500_000),
            /**
             * What this line actually contains, bullet-level, in the
             * client's vocabulary — "Complete e-commerce functionality" is
             * banned; "registration, login, browse, cart, checkout" is the
             * form (G-165, Part E). Only what the requirements support.
             */
            features: z.array(z.string().trim().min(3).max(140)).min(2).max(10),
          })
          .strict(),
      )
      .min(1, 'A quotation with no scope is a blank form')
      .max(25, 'A quotation, not a specification')
      .refine((items) => items.some((i) => i.priceRupees > 0), {
        message: 'A quotation priced at zero throughout cannot be submitted',
      }),
    /**
     * What this quotation covers and what it does not, in a sentence or two.
     *
     * §15 asks for a project summary. Exclusions matter more than inclusions
     * in a fixed-scope quotation, and they are the thing a client argues about
     * later — so the model is asked for them where it can support them.
     */
    summary: z.string().trim().min(1).max(1200),
    /**
     * The judgment lists of the document (G-165). Exclusions carry the
     * reason where the requirements show one (the v2 reference's own
     * strength); assumptions are only REAL unknowns, never padding; client
     * responsibilities name only what applies. All may be empty — an empty
     * honest list beats an invented full one (ADM-76).
     */
    exclusions: z.array(z.string().trim().min(3).max(220)).max(10),
    assumptions: z.array(z.string().trim().min(3).max(220)).max(8),
    clientResponsibilities: z.array(z.string().trim().min(3).max(220)).max(8),
  })
  .strict();

export type QuotationScope = z.infer<typeof quotationScopeSchema>;

/**
 * The shape `sales.proposals.document` holds — the model-authored judgment
 * content, stored at draft time and frozen by proposals_guard outside draft
 * (G-165). Parsed defensively wherever it is read: an older proposal has no
 * document at all, and a malformed one renders as none rather than crashing
 * a send.
 */
export const quotationDocumentSchema = z
  .object({
    understanding: z.string().nullish(),
    exclusions: z.array(z.string()).nullish(),
    assumptions: z.array(z.string()).nullish(),
    clientResponsibilities: z.array(z.string()).nullish(),
  })
  .partial();

export type QuotationDocument = z.infer<typeof quotationDocumentSchema>;

export function parseQuotationDocument(raw: unknown): QuotationDocument | null {
  if (raw === null || raw === undefined) return null;
  const parsed = quotationDocumentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function quotationScopeJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(quotationScopeSchema)) as Record<string, unknown>;
}

/**
 * The quotation, as the client reads it on WhatsApp — Doc 09 §18.
 *
 * A message rather than a document, and that is a stated limit rather than a
 * design: §12 asks for a PDF and there is no PDF generator in this repository.
 * A quotation the client can actually read beats one that is never sent, so
 * this is the honest half — and when a PDF exists it is an attachment beside
 * these words rather than a replacement for them.
 *
 * **Every number here passed through a person's decision.** The lines and
 * the total come off `sales.proposals` and `sales.proposal_items`, frozen at
 * submission and reachable only through the owner's approval (ADM-96 retired
 * the typed-by-a-person rule; the decided-by-a-person rule is the one that
 * stands). The message itself is authored by whoever pressed Send — or, on
 * the dispatch path, by the approver whose decision it executes — which is
 * what lets it carry an amount past `crm.refuse_unread_price` at all.
 *
 * Nothing is invented. A quotation with no valid-until date says nothing about
 * validity rather than assuming one, and the same for tax and discount: §12
 * lists them as things a quotation contains *where documented*, and an unset
 * column is not a documented zero.
 */
export function quotationMessage(input: {
  title: string;
  version: number;
  body: string | null;
  currency: string;
  items: ReadonlyArray<{ description: string; quantity: number; amountMinor: number }>;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  validUntil: string | null;
}): string {
  const money = (minor: number) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: input.currency || 'INR',
      maximumFractionDigits: 2,
    }).format(minor / 100);

  const lines: string[] = [`${input.title} — v${input.version}`];

  if (input.body) lines.push('', input.body);

  if (input.items.length > 0) {
    lines.push('', 'What it covers:');
    for (const item of input.items) {
      // The quantity only appears when it is not one: "Admin panel ×1" is
      // noise, and "Screens ×12" is the reason for the number beside it.
      const qty = Number(item.quantity) === 1 ? '' : ` ×${item.quantity}`;
      lines.push(`• ${item.description}${qty} — ${money(item.amountMinor)}`);
    }
  }

  lines.push('');
  if (input.discountMinor > 0 || input.taxMinor > 0) {
    lines.push(`Subtotal: ${money(input.subtotalMinor)}`);
    if (input.discountMinor > 0) lines.push(`Discount: −${money(input.discountMinor)}`);
    if (input.taxMinor > 0) lines.push(`Tax: ${money(input.taxMinor)}`);
  }
  lines.push(`Total: ${money(input.totalMinor)}`);

  if (input.validUntil) lines.push('', `Valid until ${input.validUntil}`);

  return lines.join('\n');
}
