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
/**
 * The three things a priced line may not say — G-167.
 *
 * `PRICING_KNOWLEDGE` has asked the model for these since ADM-96, and asking
 * is not the same as refusing: the corpus study found all three shipped to
 * clients anyway. Each maps to a defect counted in those 45 quotations, and
 * each is enforced HERE, at the write, rather than at render — an
 * already-approved quotation is a record of what the owner decided, and
 * retroactively refusing to draw it would break history to punish it.
 *
 * OPEN_SCOPE — an unbounded promise inside a fixed price. The corpus's own
 * instance: a wagering quotation listing 12 screens and then "Much more
 * Screens", for one fixed number. There is no version of that sentence a
 * client and an agency read the same way.
 *
 * READINESS without LIMIT — "structure ready", "API-ready", "hooks",
 * "foundation". These appear across the corpus inside fixed prices and never
 * once say what does not work at handover, which is precisely the sentence
 * that decides the argument later. The rule is not "don't ship a foundation";
 * it is "name what the foundation does not do".
 *
 * RUPEE_FIGURE in prose — the arithmetic is checked on the price fields, so a
 * rupee amount written into a description is the one number nothing verifies.
 * Percentages are deliberately NOT refused: "20% off coupons" is a product
 * feature a client asked for, and refusing it would fail the whole draft.
 */
const OPEN_SCOPE =
  /(?:(?:\band\b|&)\s+(?:much|many|lots\s+of)\s+more|\bmuch\s+more\b|\band\s+more\b|\betc\.?)(?=\W|$)/i;

const READINESS =
  /(?:\b[a-z]+[-\s]ready\b|\bready\s+for\b|\bhooks?\b|\bfoundation\b|\bscaffold(?:ing)?\b|\bstructure\s+(?:only|ready)\b)/i;

const LIMIT_CLAUSE =
  /\b(?:does\s+not|do\s+not|doesn['’]t|not\s+included|not\s+live|no\s+live|excluded|cannot|can['’]t|will\s+not|won['’]t|is\s+not|are\s+not)\b/i;

const RUPEE_FIGURE = /(?:₹|\bRs\.?|\bINR\b)\s*\d/i;

/**
 * The fault in a quotation's language, or null. Exported so the rule can be
 * tested directly and read by anything that wants to check before writing.
 *
 * One fault at a time, most-structural first: a model that gets three
 * complaints at once tends to fix the last one.
 */
export function quotationLanguageFault(scope: {
  items: ReadonlyArray<{ description: string; features: readonly string[] }>;
  summary: string;
  /** G-182 — the words the client reads first. Held to the same rules. */
  coveringNote?: string | null;
}): string | null {
  const prose: Array<{ where: string; text: string }> = [
    { where: 'the summary', text: scope.summary },
    // The covering note is the ONLY part of a quotation an agent writes that a
    // client reads as a message rather than as a document, so it is held to
    // every rule the document is — and to one more, below.
    ...(scope.coveringNote ? [{ where: 'the covering note', text: scope.coveringNote }] : []),
    ...scope.items.flatMap((item, i) => [
      { where: `line ${i + 1}`, text: item.description },
      ...item.features.map((f, j) => ({ where: `line ${i + 1}, bullet ${j + 1}`, text: f })),
    ]),
  ];

  for (const { where, text } of prose) {
    const open = text.match(OPEN_SCOPE);
    if (open) {
      return `${where} leaves the scope open with "${open[0].trim()}" — a fixed price cannot cover an unbounded list. Name the items, or leave them out.`;
    }
  }

  // Readiness is judged per LINE, not per string: the limit may honestly live
  // in a sibling bullet ("Razorpay hooks" … "does not process a live payment
  // until the client's keys are added"), which is how a person would write it.
  for (const [i, item] of scope.items.entries()) {
    const lineText = [item.description, ...item.features].join(' • ');
    const ready = lineText.match(READINESS);
    if (ready && !LIMIT_CLAUSE.test(lineText)) {
      return `line ${i + 1} promises "${ready[0].trim()}" without saying what does not work at handover. Add that sentence to the line, or price the working thing.`;
    }
  }

  for (const { where, text } of prose) {
    const rupee = text.match(RUPEE_FIGURE);
    if (rupee) {
      return `${where} writes the amount "${rupee[0].trim()}" into prose. Amounts belong in the price fields, which are the ones the arithmetic is checked on.`;
    }
  }

  return null;
}

/**
 * The industry a quotation dresses itself for — G-167, corpus study §19.
 *
 * Twelve values because the corpus had twelve recognisable kinds of client,
 * and `general` because "I could not tell" is a real answer that must not
 * become a guess. The list is duplicated as accent colours in the renderer
 * (which lives in `src/lib` and may not import this module); a test pins the
 * two lists equal, which is the repository's usual answer to a roster that
 * has to exist in two places.
 *
 * This is decoration and only decoration. It changes an accent hue at three
 * places and nothing else — no section, no number, no sentence.
 */
export const QUOTATION_INDUSTRIES = [
  'general',
  'marketplace',
  'ecommerce',
  'logistics',
  'fintech',
  'health',
  'education',
  'media',
  'saas',
  'realestate',
  'ai',
  'faith',
  'gaming',
] as const;

/**
 * The categories that carry a clause set rather than a colour — corpus §14.
 *
 * The corpus disclaimed licensing properly on the casino quotation and RBI /
 * NBFC compliance on all three lending ones, and then shipped a wagering
 * quotation — an admin panel with "Result logic control" and "Payout ratio
 * control" — carrying no regulatory sentence at all. The document that most
 * needed the clause was the one without it.
 *
 * So this is NOT the model's decoration. `regulatedCategoryFor` in the
 * standards module takes whatever the model declares and can only ADD to it
 * from the scope's own words: a model that says null while writing "wallet,
 * deposit, payout, betting" still gets the clause set. A compliance control
 * a model can opt out of is not a control.
 */
export const REGULATED_CATEGORIES = ['gaming', 'lending', 'health', 'payouts'] as const;

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
             * What KIND of line this is — G-169, and the reason is the
             * pricing reference.
             *
             * `laneReferenceFor` has to count surfaces, and until now it
             * read them out of prose with a regex: "Customer app" counts,
             * "Backend, APIs and database" must not, and every judgement
             * between those was a guess. The model knows which is which
             * because it wrote the line. Optional, because a draft from
             * before this field existed still has to price.
             *
             * A `surface` is something a person opens and uses. Everything
             * that builds, integrates, tests or ships one is `foundation`.
             */
            kind: z.enum(['surface', 'foundation']).optional(),
            /**
             * What this line actually contains, bullet-level, in the
             * client's vocabulary — "Complete e-commerce functionality" is
             * banned; "registration, login, browse, cart, checkout" is the
             * form (G-165, Part E). Only what the requirements support.
             */
            features: z.array(z.string().trim().min(3).max(140)).min(2).max(10),
            /**
             * Which of the quotation's declared roles this line is for —
             * G-178.
             *
             * The cheapest honest way to say what the build is made of. A
             * separate "modules" taxonomy beside `items` would be a second
             * description of the same work, and the two would drift; a line
             * naming its audience gives the module × role matrix the brief
             * asks for out of the structure that already exists.
             *
             * Every name here must appear in `roles`, checked below. A model
             * naming an audience it never defined has invented a user, and a
             * quotation that invents a user has invented scope.
             */
            serves: z.array(z.string().trim().min(2).max(40)).max(6).optional(),
            /**
             * Developer-days this line takes — G-179, and the only honest
             * source for it is the model that wrote the line.
             *
             * The corpus timeline band is derived FROM the price, so using
             * it to estimate effort would make the cost a function of the
             * price and the whole comparison circular. This is the number
             * the production-cost model multiplies by the agency's own day
             * rate; it is APPROVER-ONLY and never drawn on anything a
             * client receives.
             *
             * Optional, and half-answered is treated as unanswered: a cost
             * built from three of five lines is an underestimate wearing a
             * cost's clothes, and `productionCostFor` refuses it.
             */
            effortDays: z.number().int().min(1).max(400).optional(),
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
    /**
     * The three fields G-167 added, all OPTIONAL on purpose — G-164's lesson
     * is that a wire-schema change is a production risk, and a model that
     * omits any of these still drafts a valid quotation that renders exactly
     * as it did before.
     *
     * `dependencies` is the corpus's missing sixth scope state: what must be
     * true or finished first. Present in ~14/45 and scattered when it was.
     *
     * `acceptanceCriteria` is generalised from the only 8 documents that had
     * it (the DharmikIndia phases) — the testable pass conditions that turn
     * "is it done?" from an argument into a checklist.
     */
    dependencies: z.array(z.string().trim().min(3).max(220)).max(6).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(3).max(220)).max(6).optional(),
    /**
     * Named, priced, and OUTSIDE the total — corpus §11.2. Nine documents
     * offered add-ons and five priced them as ranges ("₹45,000 – 65,000"),
     * which is an invitation to negotiate at the bottom of the range later.
     * One number or nothing.
     */
    /**
     * The words the client reads first — G-182.
     *
     * A zero-trust audit traced the flow's CLIENT QUOTATION DELIVERY step and
     * found the agent had nothing to do with it: the send composed a fixed
     * template from the row — title, lines, total, validity — and nobody
     * explained anything. The client received a price list from a system that
     * had spent a whole conversation understanding them.
     *
     * Two to four sentences, in the language the client has been writing in,
     * saying what they are getting and what happens next.
     *
     * ── written at DRAFT time, not at send time ─────────────────────────
     *
     * The obvious place for this is the moment of sending, and it is the
     * wrong one for two reasons. A model call on the send path adds a failure
     * mode to the one action a client is waiting for. And more importantly,
     * words written after the approval are words the owner never approved —
     * whereas these ride in the announcement, so the person who decides the
     * price also decides what is said about it.
     *
     * ── and it may not contain a number ─────────────────────────────────
     *
     * `quotationLanguageFault` already refuses a rupee figure in prose, and
     * that rule now covers this field. The deterministic block below the note
     * carries every figure, checked by the same arithmetic gate as the PDF.
     * So the agent explains, and cannot misstate a price — which is what lets
     * it write client-facing words about money at all under ADM-22.
     */
    coveringNote: z.string().trim().min(40).max(600).optional(),
    /**
     * Who uses this thing — G-178.
     *
     * The brief asks a quotation to identify user roles, and until now the
     * only place a role could appear was as prose inside a line's
     * description. That made the commonest scope dispute in the corpus
     * unrepresentable: *we thought the admin could do that too.* A named role
     * with one sentence about what they do is the smallest thing that settles
     * it before it is an argument.
     *
     * Optional and capped at six. A quotation with one kind of user says so
     * by listing one; a quotation listing nine has stopped describing this
     * project.
     */
    roles: z
      .array(
        z
          .object({
            name: z.string().trim().min(2).max(40),
            /** What this person can actually do. Never "manages the system". */
            whatTheyDo: z.string().trim().min(10).max(200),
          })
          .strict(),
      )
      .max(6)
      .optional(),
    /**
     * The third-party services this build stands on, and WHO PAYS — G-178,
     * and the second half is the commercially load-bearing one.
     *
     * The brief asks for third-party services and their charges. This names
     * the service, what it is for, and whose bill it lands on — and it
     * deliberately does NOT invent a price.
     *
     * ── why there is no number field ────────────────────────────────────
     *
     * A gateway's percentage, a store's annual fee and an SMS rate all move,
     * and none of them is the agency's to promise. A figure printed inside a
     * fixed-price quotation becomes a commitment the agency cannot keep and
     * did not make. `charge` is free text so the model can write what the
     * requirements actually established — *"2% per transaction, billed to the
     * client's own Razorpay account"* — and write nothing when they
     * established nothing, which is the honest answer and the common one.
     *
     * `whoPays` is the enum because it is the part that causes the argument.
     */
    integrations: z
      .array(
        z
          .object({
            name: z.string().trim().min(2).max(60),
            purpose: z.string().trim().min(10).max(200),
            whoPays: z.enum(['client', 'included']),
            charge: z.string().trim().min(3).max(160).optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    /**
     * How long this build takes, in weeks — G-177.
     *
     * The corpus quotes a BAND and never a date (45/45), and the band travels
     * with `TIMELINE_TERMS`'s three sentences about when the clock starts. So
     * this is two numbers, not a delivery date, and the schema cannot express
     * one.
     *
     * ── why this field had to exist ─────────────────────────────────────
     *
     * Until now the timeline was `timelineBandFor(totalMinor)` — a pure
     * function of the PRICE across five bands, and the only field of the
     * quotation nobody could change. An owner writing *"timeline 25 days se 20
     * days"* on a revision had no way to be obeyed: the reviser applied every
     * other instruction in the note and silently dropped that one, and the
     * document came back with the same band unless the price happened to cross
     * an edge. A zero-trust audit found it by tracing that exact sentence.
     *
     * Optional, and the fallback is the band. Every quotation drafted before
     * this field existed renders precisely as it did.
     */
    timelineWeeks: z
      .object({
        min: z.number().int().min(1).max(104),
        max: z.number().int().min(1).max(104),
      })
      // Strict, so a model answering with `deliverBy: '2026-11-01'` is refused
      // rather than quietly stripped. The corpus quotes a band and never a
      // date (45/45), and a date is the one thing a client will hold the
      // agency to that this document deliberately does not promise.
      .strict()
      .refine((t) => t.min <= t.max, {
        message: 'A timeline cannot end before it starts — min must not exceed max',
      })
      .optional(),

    optionalAddons: z
      .array(
        z
          .object({
            label: z.string().trim().min(3).max(160),
            priceRupees: z.number().int().min(1).max(2_500_000),
          })
          .strict(),
      )
      .max(6)
      .optional(),
    /**
     * How deep this build goes — G-169, the second half of making the
     * pricing reference exact. The corpus's own ladders move a price ×1.4
     * to ×4.3 on depth alone (lending, EHSAAS, Tango, MAVIGUN, Multivendor),
     * so guessing it from adjectives was the largest error term in the
     * reference. Optional; absent reads as `standard`, which is the middle
     * and never the cheap assumption.
     */
    depth: z.enum(['basic', 'standard', 'full']).optional(),
    /**
     * A phase of a larger programme — G-169, generalised from the only 8
     * documents in the corpus that did this (the DharmikIndia phases) and
     * the best dispute-prevention device in the folder.
     *
     * The load-bearing field is `deferredTo`: naming what this phase does
     * NOT include AND which phase owns it turns "why isn't X there?" into
     * "X is phase 5". An exclusion says no; a deferral says not yet, and
     * by whom — which is the difference between an argument and a plan.
     */
    phase: z
      .object({
        number: z.number().int().min(1).max(20),
        of: z.number().int().min(2).max(20),
        deferredTo: z
          .array(
            z
              .object({
                item: z.string().trim().min(3).max(160),
                phase: z.number().int().min(1).max(20),
              })
              .strict(),
          )
          .max(12),
      })
      .strict()
      .refine((p) => p.number <= p.of, { message: 'A phase cannot be numbered beyond the programme' })
      .refine((p) => p.deferredTo.every((d) => d.phase > p.number), {
        message: 'A deferral must name a LATER phase — otherwise it is an exclusion, not a deferral',
      })
      .optional(),
    /** Decoration only (G-167). Absent is `general`, which changes nothing. */
    industryTheme: z.enum(QUOTATION_INDUSTRIES).optional(),
    /**
     * The model's reading of whether this is regulated work. Advisory: the
     * standards module can only ADD categories to it, never remove one.
     */
    regulatedCategory: z.enum(REGULATED_CATEGORIES).nullish(),
  })
  .strict()
  // G-167: the language rules, refused rather than merely asked for. A draft
  // that fails this never reaches `draft_proposal`, so the owner never has to
  // catch it on the PDF.
  .superRefine((scope, ctx) => {
    const fault = quotationLanguageFault(scope);
    if (fault) ctx.addIssue({ code: 'custom', message: fault });

    /**
     * A line may only serve a role the quotation declared — G-178.
     *
     * Checked here rather than left to a reader, because the failure is
     * silent and expensive: a line that says it serves the "Franchise owner"
     * of a quotation whose roles are Customer and Admin has invented a user,
     * and a quotation that invents a user has invented scope. The client
     * reads it, agrees to it, and asks for it at handover.
     *
     * Case-insensitive, because "admin" and "Admin" are one person, and a
     * refusal over capitalisation would be a rule about typing rather than
     * about scope.
     */
    const declared = new Set((scope.roles ?? []).map((r) => r.name.trim().toLowerCase()));
    scope.items.forEach((item, index) => {
      for (const role of item.serves ?? []) {
        if (declared.has(role.trim().toLowerCase())) continue;
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'serves'],
          message: declared.size === 0
            ? `"${role}" is named as a user of this line, but the quotation declares no roles at all`
            : `"${role}" is not one of this quotation's roles (${[...declared].join(', ')})`,
        });
      }
    });
  });

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
    // G-167. Every one nullish for the same reason the four above are: a
    // proposal drafted before this change has none of them, and reads back
    // as a document with none of them rather than as a parse failure.
    dependencies: z.array(z.string()).nullish(),
    acceptanceCriteria: z.array(z.string()).nullish(),
    optionalAddons: z
      .array(z.object({ label: z.string(), priceRupees: z.number() }).loose())
      .nullish(),
    industryTheme: z.string().nullish(),
    regulatedCategory: z.string().nullish(),
    /** G-182 — the words the client reads above the figures. */
    coveringNote: z.string().nullish().catch(null),
    // G-169 — the structured scope facts and the phase block.
    depth: z.string().nullish(),
    /**
     * G-178 — who uses it, and what it stands on.
     *
     * `.catch(null)` on each for the reason `timelineWeeks` has it: these have
     * been through a jsonb column, and one malformed entry must not make the
     * whole document unparseable and take the understanding, the exclusions
     * and the assumptions down with it.
     */
    roles: z
      .array(z.object({ name: z.string(), whatTheyDo: z.string() }).loose())
      .nullish()
      .catch(null),
    integrations: z
      .array(
        z
          .object({
            name: z.string(),
            purpose: z.string(),
            whoPays: z.string(),
            charge: z.string().nullish(),
          })
          .loose(),
      )
      .nullish()
      .catch(null),
    /**
     * G-179 — what the work costs to make, and the owner's own bands above
     * it, frozen at draft time exactly as `pricingReference` is.
     *
     * Recomputing at render would answer a different question: what TODAY'S
     * day rate says about an August quotation. The rates are editable from a
     * settings page now, so they WILL move, and that is precisely the drift
     * that would silently rewrite history.
     */
    productionCost: z
      .object({
        days: z.number(),
        costRupees: z.number(),
        minimumRupees: z.number(),
        recommendedRupees: z.number(),
        premiumRupees: z.number(),
        basis: z.array(z.string()),
      })
      .loose()
      .nullish()
      .catch(null),
    /**
     * G-177 — the timeline the model proposed, or the owner revised.
     *
     * Frozen with the document, like everything else here. `timelineBandFor`
     * still answers when this is absent, so a quotation drafted before the
     * field existed renders exactly as it did — and an APPROVED one keeps the
     * timeline it was approved with rather than acquiring a new one because
     * the price band moved underneath it.
     */
    timelineWeeks: z
      .object({ min: z.number(), max: z.number() })
      .loose()
      .nullish()
      // `.catch(null)` rather than a hard failure: this value has been through
      // a jsonb column, and `z.number()` refuses a null or a NaN. Without the
      // catch, one bad timeline makes the ENTIRE document unparseable — the
      // understanding, the exclusions, the assumptions, all of it — and the
      // quotation renders with none of them. The timeline is optional; losing
      // it must not lose the document around it.
      .catch(null),
    // G-172 — the formula's reading of this shape, frozen beside the price
    // the owner decided. Declared here so it survives the parse; the funnel
    // reads it back to report what the anchor costs.
    pricingReference: z
      .object({
        lane: z.number(),
        referenceRupees: z.number(),
        proposedRupees: z.number(),
        surfaces: z.number(),
        depth: z.string(),
      })
      .loose()
      .nullish(),
    phase: z
      .object({
        number: z.number(),
        of: z.number(),
        deferredTo: z.array(z.object({ item: z.string(), phase: z.number() }).loose()).nullish(),
      })
      .loose()
      .nullish(),
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
  /**
   * The proposal's frozen document — G-182, and it is the DOCUMENT rather
   * than a pre-parsed note on purpose.
   *
   * Two doors send a quotation: the manual button and the approved-quotation
   * dispatch. Handing each of them the parsing to do is two chances to do it
   * differently; handing both the raw column means they cannot. It also keeps
   * `crm/handlers.ts` out of `sales/schema.ts`, which ARCHITECTURE.md §3.2
   * forbids — cross-module access goes through service.ts, and the lint says
   * so.
   *
   * Absent or malformed, the message composes exactly as it always did: every
   * quotation sent before this field existed reads identically.
   */
  document?: unknown;
}): string {
  const money = (minor: number) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: input.currency || 'INR',
      maximumFractionDigits: 2,
    }).format(minor / 100);

  const lines: string[] = [];

  // The note first, then a blank line, then the document. A client opening
  // this on a phone reads two sentences that make sense before they reach a
  // price list — which is the whole difference between a quotation and an
  // invoice arriving out of nowhere.
  const note = (parseQuotationDocument(input.document ?? null)?.coveringNote ?? '').trim();
  if (note) lines.push(note, '');

  lines.push(`${input.title} — v${input.version}`);

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
