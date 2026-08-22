import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';

/**
 * Input validation for the crm module (ARCHITECTURE.md §3.2 — the only place
 * it happens).
 */

/**
 * Lead pipeline states — the same vocabulary as the crm.leads status CHECK.
 * Restated here so an invalid transition is refused before it reaches the
 * database, not as a second source of truth.
 */
export const LEAD_STATUSES = [
  'new',
  'qualifying',
  'qualified',
  'disqualified',
  'converted',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Which moves are legal, as data.
 *
 * `converted` is terminal: a lead that became a project does not go back into
 * the pipeline. `disqualified` is not terminal — deals do come back, and
 * reopening one is a normal sales action rather than a data repair.
 */
export const LEAD_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  new: ['qualifying', 'disqualified'],
  qualifying: ['qualified', 'disqualified'],
  qualified: ['converted', 'disqualified'],
  disqualified: ['qualifying'],
  converted: [],
};

export const updateLeadStatusSchema = z.object({
  leadId: z.uuid(),
  status: z.enum(LEAD_STATUSES),
  /** Required when disqualifying — "why" is the only useful part of a lost deal. */
  reason: z.string().trim().max(500).optional(),
});

export const addLeadNoteSchema = z.object({
  leadId: z.uuid(),
  body: z.string().trim().min(1, 'A note cannot be empty').max(5_000),
});

/**
 * The six ADM-10 §7 moved out of the pipeline — G-010.
 *
 * §7 keeps the pipeline at four stages and says everything else the agency
 * actually does is *"recorded as a timestamped activity on the lead, not as a
 * pipeline stage. A deal is in one stage; a lead has a history."* These are
 * that history, and until G-010 they could not be recorded at all.
 *
 * Exactly six, in the order §7 lists them. A seventh is a decision, not an
 * addition here — ADM-10 named these and no more.
 */
export const SALES_ACTIVITY_KINDS = [
  'contacted',
  'sample_sent',
  'demo_sent',
  'offer_sent',
  'follow_up',
  'advance_requested',
] as const;

export type SalesActivityKind = (typeof SALES_ACTIVITY_KINDS)[number];

/** What each reads as on the timeline, so a screen does not invent wording. */
export const SALES_ACTIVITY_LABELS: Record<SalesActivityKind, string> = {
  contacted: 'Contacted',
  sample_sent: 'Sample sent',
  demo_sent: 'Demo sent',
  offer_sent: 'Offer sent',
  follow_up: 'Follow-up',
  advance_requested: 'Advance requested',
};

/**
 * The list of samples, demos and past work AgencyOS may send — G-013, ADM-12.
 *
 * Business rules §5.3: *"AgencyOS may send samples, demos and past work **only
 * from a list the Admin maintains**. The list is empty until the Admin fills
 * it; until then AgencyOS sends nothing from it."*
 *
 * The three kinds are §5.3's own words. A fourth is a decision, not an edit.
 */
export const PORTFOLIO_KINDS = ['sample', 'demo', 'past_work'] as const;

export type PortfolioKind = (typeof PORTFOLIO_KINDS)[number];

export const PORTFOLIO_KIND_LABELS: Record<PortfolioKind, string> = {
  sample: 'Sample',
  demo: 'Demo',
  past_work: 'Past work',
};

export const addPortfolioItemSchema = z.object({
  kind: z.enum(PORTFOLIO_KINDS),
  title: z.string().trim().min(1, 'A title is needed').max(200),
  description: z.string().trim().max(2_000).optional(),
  /**
   * Required, and the migration header says why: §5.3's list holds things that
   * may be *sent*, so an entry that cannot be sent would satisfy the schema
   * and not the rule.
   */
  url: z.string().trim().url('That does not look like a link').max(2_000),
});

export const setPortfolioItemActiveSchema = z.object({
  itemId: z.uuid(),
  isActive: z.boolean(),
});

export const recordSalesActivitySchema = z.object({
  leadId: z.uuid(),
  kind: z.enum(SALES_ACTIVITY_KINDS),
  /**
   * Optional, unlike a note's. The act is the record — that a demo was sent is
   * the fact §7 wants kept, and demanding a sentence about it would make the
   * cheapest thing to record the one nobody records.
   */
  body: z.string().trim().max(5_000).optional(),
});

/**
 * Lead qualification — whether the deal is worth pursuing.
 *
 * Distinct from `requirements`, which is what the client wants built.
 *
 * Field choice is deliberately conservative: budget is an integer in the
 * organization's minor units (ARCHITECTURE.md §4.1 rule 5 — never a float, and
 * no invented "band" vocabulary), and timeline stays free text rather than an
 * enum the business has not defined yet. Promote either to a controlled
 * vocabulary once real usage shows what the values actually are.
 */
export const leadQualificationSchema = z.object({
  budgetMinor: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
  timelineNote: z.string().trim().max(200).optional(),
  isDecisionMaker: z.boolean().optional(),
  notes: z.string().trim().max(2_000).optional(),
});

export const setLeadQualificationSchema = z.object({
  leadId: z.uuid(),
  qualification: leadQualificationSchema,
});

export const setLeadFollowUpSchema = z.object({
  leadId: z.uuid(),
  /** ISO timestamp, or null to clear the reminder. */
  nextFollowUpAt: z.iso.datetime().nullable(),
});

export const startConversationSchema = z.object({
  leadId: z.uuid(),
  channel: z.enum(['manual', 'whatsapp', 'web_form', 'email']).default('manual'),
});

export const appendMessageSchema = z.object({
  conversationId: z.uuid(),
  /** 'client' is the customer, 'user' a staff member. Same vocabulary as
   *  crm.lead_activities.actor_type; 'agent' is written by the runner, not here. */
  authorType: z.enum(['user', 'client']),
  body: z.string().trim().min(1, 'Message cannot be empty').max(10_000),
});

export const requestExtractionSchema = z.object({
  conversationId: z.uuid(),
});

/**
 * The structured shape a requirement extraction must produce.
 *
 * ── Why these four fields and no others ───────────────────────────────────
 * Requirements exist to feed the Proposal Drafter, so the payload carries what
 * sales.proposals and sales.proposal_items actually consume and nothing more:
 *
 *   summary        → sales.proposals.body
 *   scopeItems[]   → sales.proposal_items.description (one row each)
 *   constraints[]  → qualifiers that shape scope (deadlines, stack, compliance)
 *   openQuestions[]→ what the interview still needs; the whole point of an
 *                    agent whose registry description is "Interviews a lead to
 *                    gather structured project requirements"
 *
 * Budget and pricing are deliberately absent: Budget Qualification is a
 * separate, explicitly out-of-scope phase, and putting a money field here now
 * would prejudge its design.
 */
export const requirementPayloadSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  scopeItems: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        detail: z.string().trim().max(2_000).optional(),
      }),
    )
    .max(50),
  constraints: z.array(z.string().trim().min(1).max(500)).max(50),
  openQuestions: z.array(z.string().trim().min(1).max(500)).max(50),
});

export type UpdateLeadStatusInput = z.infer<typeof updateLeadStatusSchema>;
export type AddLeadNoteInput = z.infer<typeof addLeadNoteSchema>;
export type RecordSalesActivityInput = z.infer<typeof recordSalesActivitySchema>;
export type AddPortfolioItemInput = z.infer<typeof addPortfolioItemSchema>;
export type SetPortfolioItemActiveInput = z.infer<typeof setPortfolioItemActiveSchema>;
export type LeadQualification = z.infer<typeof leadQualificationSchema>;
export type SetLeadQualificationInput = z.infer<typeof setLeadQualificationSchema>;
export type SetLeadFollowUpInput = z.infer<typeof setLeadFollowUpSchema>;
export type StartConversationInput = z.infer<typeof startConversationSchema>;
export type AppendMessageInput = z.infer<typeof appendMessageSchema>;

/**
 * Sending one to the client — gap G-014.
 *
 * `idempotencyKey` is required and has no default. A caller that forgot it
 * would get at-least-once delivery to a paying customer, so leaving it out
 * must fail to type-check rather than working most of the time: the unique
 * index on (organization_id, external_ref) is what turns a retried Server
 * Action into the same message rather than a second one.
 */
export const sendClientMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1, 'A message needs something in it').max(4000),
  idempotencyKey: z.string().trim().min(8).max(120),
});

export type SendClientMessageInput = z.infer<typeof sendClientMessageSchema>;
export type RequestExtractionInput = z.infer<typeof requestExtractionSchema>;
export type RequirementPayload = z.infer<typeof requirementPayloadSchema>;

export function requirementJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(requirementPayloadSchema)) as Record<string, unknown>;
}

/**
 * Linking a WhatsApp group — G-015 (the client's project group) and G-109
 * (the internal approval group).
 *
 * `externalRef` is the provider's group id, not something a person types from
 * memory: it comes from the group's own metadata. Trimmed and bounded because
 * it reaches a unique index that decides which tenant owns a group.
 */
export const linkWhatsAppGroupSchema = z
  .object({
    kind: z.enum(['project_group', 'internal_group']),
    externalRef: z.string().trim().min(1, 'A group id is required').max(200),
    projectId: z.uuid().optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => (v.kind === 'project_group') === (v.projectId !== undefined), {
    message: 'A project group needs a project, and an internal group must not name one',
    path: ['projectId'],
  });

export type LinkWhatsAppGroupInput = z.infer<typeof linkWhatsAppGroupSchema>;

// ── the internal approval group (G-110, ADM-11) ─────────────────────────────

/**
 * The `approval.requested` payload `approvals.request_approval` emits.
 *
 * Validated rather than trusted: it arrives through the outbox and the job
 * queue, and a handler that read it optimistically would turn a malformed
 * event into a message somebody's owner receives.
 */
export const approvalRequestedEventSchema = z.object({
  reference: z.string().trim().min(1).max(16),
  subjectType: z.string().trim().min(1).max(40),
  subjectId: z.uuid().nullable().optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  amountMinor: z.number().int().nullable().optional(),
  requiredRole: z.string().trim().max(40).nullable().optional(),
  slaDueAt: z.string().nullable().optional(),
});

export type ApprovalRequestedEvent = z.infer<typeof approvalRequestedEventSchema>;

/** What a subject type is called in a sentence somebody reads on a phone. */
const SUBJECT_WORDS: Record<string, string> = {
  proposal: 'Quotation',
  deliverable: 'Deliverable',
  invoice: 'Invoice',
  refund: 'Refund',
  scope_change: 'Scope change',
  prototype: 'Prototype',
  agent_action: 'Agent action',
  ticket_plan: 'Ticket plan',
};

/**
 * The message the internal group actually receives.
 *
 * Short on purpose: this is read on a phone, and §5.1 calls the group an
 * approval channel rather than a chat log. It carries the four things a
 * decision needs — what, how much, who must answer, and the code to quote
 * back — and nothing else.
 *
 * The money is rendered from minor units here rather than being sent
 * pre-formatted in the event, so the event stays the fact and this stays the
 * presentation. `en-IN` matches every other money string in the application.
 */
export function announcementFor(event: ApprovalRequestedEvent): string {
  const what = SUBJECT_WORDS[event.subjectType] ?? event.subjectType;

  const lines = [`${what} needs a decision.`];

  if (event.summary) lines.push(event.summary);

  if (typeof event.amountMinor === 'number') {
    lines.push(
      new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 2,
      }).format(event.amountMinor / 100),
    );
  }

  if (event.requiredRole) lines.push(`Needs: ${event.requiredRole.replace('_', ' ')}`);

  // The code, last and on its own line, because it is the thing somebody has
  // to carry back into AgencyOS to find this request and nothing else.
  //
  // It used to read "Reply quoting <code>." — written when whether a reply
  // could settle an approval was still an open question. ADM-74 answered it:
  // the reply is advisory and settles nothing, because `decide_approval`
  // requires a signed-in approver and `core.users` has no phone to match a
  // sender against. Nothing reads replies to this message and nothing will.
  //
  // So the old line invited an action that does nothing, and an approver who
  // followed it would believe they had approved something while the request
  // sat untouched. The wording now does what ADM-74 permits the channel to do
  // — carry the reference and point at AgencyOS — and no more.
  //
  // Deliberately no link: the production domain is one of ADM-60's deferred
  // facts, and a URL built from an unset `NEXT_PUBLIC_APP_URL` would be the
  // same defect wearing a different coat.
  lines.push(`Decide it in AgencyOS. Reference ${event.reference}.`);

  return lines.join('\n');
}

/**
 * Document 08 §12's twenty-two intents, in its own two lists.
 *
 * Same vocabulary as the `crm.conversation_messages.intent` CHECK. Closed,
 * because §12 is a list rather than a suggestion and an intent somebody
 * invented for the occasion is one no report can group.
 */
export const LEAD_INTENTS = [
  'new_enquiry',
  'service_inquiry',
  'price_inquiry',
  'requirement_sharing',
  'trust_concern',
  'negotiation',
  'quotation_request',
  'acceptance',
  'follow_up',
  'not_interested',
] as const;

export const PROJECT_INTENTS = [
  'progress_inquiry',
  'feedback',
  'approval',
  'change_request',
  'bug_report',
  'payment_message',
  'payment_proof',
  'support_request',
  'cancellation_request',
  'handover_request',
  'new_project_inquiry',
  'upsell_response',
] as const;

export const MESSAGE_INTENTS = [...LEAD_INTENTS, ...PROJECT_INTENTS] as const;

/**
 * What the sales agent may say about a client's message.
 *
 * **One label and a sentence of evidence, and nothing that acts.**
 *
 * Two of §12's intents are why that matters. `acceptance` and `approval` are
 * exactly the readings Doc 08 §14 refuses to let anybody infer — *"Do not infer
 * acceptance from a generic 'looks good'"* — and business rules §5 makes
 * *"treat a client's word as a fact"* one of the five things no agent may do at
 * any level.
 *
 * So the schema has no field for a status, a decision, a confidence or a
 * suggested reply. The agent reads a message and names what it is. Everything
 * that could follow from that is somebody else's act, and there is no path from
 * this label to any of them to guard.
 */
export const messageIntentSchema = z
  .object({
    intent: z.enum(MESSAGE_INTENTS),
    /**
     * Doc 08 §8, asked for in the same call as the intent because §12's own
     * flow puts them in that order — *PARSE CONTENT → LANGUAGE → INTENT*.
     *
     * A primary tag alone, or `primary-secondary` for a message that genuinely
     * mixes two: §8's *"Support mixed-language messages such as Hinglish"* is
     * `hi-en`, which says **which** two rather than collapsing to a flag.
     *
     * No enumeration, because which languages this agency works in is business
     * configuration nobody has given — the pattern constrains the shape, not
     * the membership. And no confidence, because nothing would read one; a
     * column with no consumer is what G-130 and G-133 both record.
     */
    /**
     * Nullable, because a message can contain no words.
     *
     * A photograph with no caption is one — and it was labelled `en` on
     * production, because the agent's own English description of the
     * screenshot was the only prose in front of the model. Nothing broke that
     * time, and only because the contact already had a language: the trigger
     * `crm.maintain_preferred_language` writes `crm.contacts.preferred_language`
     * from the FIRST message that carries one and never again, so a client
     * whose opening message is a caption-less screenshot would have been
     * answered in English for ever after.
     *
     * The language of a message is the language THEY wrote in. When they wrote
     * nothing, there is no answer, and null is the only honest one.
     */
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(-[a-z]{2,3})?$/, 'A language tag, or two joined by a hyphen for a mixed message')
      .nullable(),
    /**
     * Doc 05 §5's Lead Memory, from the same reading — a durable fact the
     * client **stated**, or null, which is what most messages carry.
     *
     * §17: *"Promote stable facts, not every transient statement"* and
     * *"Prefer explicit client statements over inferred preferences."* So it
     * is what they said, not what it suggests: *"my co-founder signs off on
     * spend"* is a fact; *"seems price-sensitive"* is a guess, and a guess is
     * the thing §17 ends by forbidding — *"Never allow an AI hallucination to
     * silently become a permanent client fact."*
     *
     * What makes it safe to write at all is that the row cannot claim to be
     * `explicit` without naming the message it came from, and cannot claim to
     * be `verified` at any confidence when an agent wrote it. Both are
     * constraints on `ai.memory_records`, not instructions here.
     */
    clientFact: z
      .object({
        kind: z
          .string()
          .trim()
          .regex(/^[a-z][a-z0-9_]{2,40}$/, 'A short lower-case kind, like decision_maker'),
        fact: z.string().trim().min(1).max(300),
      })
      .strict()
      .nullable(),
    quote: z
      .string()
      .trim()
      .min(1, 'Point at the words you read this from')
      .max(300),
  })
  .strict();

export type MessageIntent = z.infer<typeof messageIntentSchema>;

export function messageIntentJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(messageIntentSchema)) as Record<string, unknown>;
}

/**
 * Document 17 §18's responsibilities, as the only things a check-in point
 * can be. Mirrors the CHECK in
 * `20260822190000_customer_success_prepares_the_conversation`.
 */
export const CHECK_IN_KINDS = [
  'confirm_access',
  'confirm_use',
  'unresolved_issue',
  'training_need',
  'feedback_to_collect',
  'renewal_timing',
  'possible_new_work',
] as const;
export type CheckInKind = (typeof CHECK_IN_KINDS)[number];

/**
 * What the customer success agent may say is worth raising with a client.
 *
 * **A list of points for a person to raise. Not a message, and not a promise.**
 *
 * Document 17 §18 ends its list of eleven responsibilities with the one that
 * shapes the schema: *"Never promise free work outside contract/policy."*
 * §22 puts the check-in itself under customer success *communication*, and
 * ADM-61 §3 keeps client-facing work behind a person — so nothing here is
 * addressed to anybody, and no column holds a recipient.
 *
 * Four absences, each a rule rather than a guard against breaking one:
 *
 * - **no amount, price or discount.** ADM-22: every price is a human's.
 *   §18's "never promise free work" is that prohibition from the other side.
 * - **no date or commitment.** A brief that says *we'll fix it Friday* is a
 *   promise, and promising is not reviewing.
 * - **no health score.** §24 wants health *"explainable and based on recorded
 *   signals"* and Doc 18 §12/§15 put the weights with the Admin. ADM-88
 *   already refused an invented lead score; this is the same number.
 * - **no status on anything.** The brief closes no issue, moves no ticket and
 *   opens no opportunity. `possible_new_work` names one — §18's *"route
 *   commercial opportunities to Sales"* — and naming is the whole of it.
 */
export const checkInBriefSchema = z
  .object({
    points: z
      .array(
        z
          .object({
            kind: z.enum(CHECK_IN_KINDS),
            note: z
              .string()
              .trim()
              .min(1, 'Say what to raise, and why it is worth raising')
              .max(600),
            /** The recorded item this point is about, when it is about one. */
            maintenanceItemId: z.string().uuid().nullable(),
          })
          .strict(),
      )
      .min(1, 'A check-in with nothing to raise is not a check-in'),
  })
  .strict();

export type CheckInBrief = z.infer<typeof checkInBriefSchema>;

export function checkInBriefJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(checkInBriefSchema)) as Record<string, unknown>;
}

/**
 * Document 09 §9's fifteen qualification areas, and no sixteenth.
 *
 * Mirrors the CHECK in
 * `20260822220000_what_the_conversation_already_answered`.
 */
export const QUALIFICATION_AREAS = [
  'what_to_build',
  'service_type',
  'target_users',
  'platforms',
  'core_features',
  'integrations',
  'design_expectations',
  'timeline',
  'budget',
  'urgency',
  'decision_maker',
  'existing_assets',
  'special_requirements',
  'language',
  'trust_concerns',
  'payment_expectations',
] as const;
export type QualificationArea = (typeof QUALIFICATION_AREAS)[number];

/**
 * What the qualifier may say a conversation has already answered.
 *
 * **An area and the client's own sentence. Never a number, and never a
 * verdict.**
 *
 * Document 09 §9: *"The Sales Agent should not interrogate the lead with a
 * rigid checklist when the conversation already provides the answer."* This is
 * that instruction as data — what is left to ask is the difference between
 * fifteen and what is here.
 *
 * Two numbers are deliberately absent, and they are absent for different
 * reasons:
 *
 * - **No score.** §10 asks for one across ten dimensions and says the weights
 *   are Admin-configurable. ADM-88 answered it, and `crm.leads.score` is a
 *   column that is always null carrying that answer as its comment.
 * - **No amount.** §9's budget area is recorded as the sentence it was said
 *   in. `qualification.budgetMinor` is an integer a person types after
 *   deciding what the client meant, and parsing *"maybe around two lakh,
 *   depends"* into `200000` is treating a client's word as a fact — one of the
 *   five things business rules §5 forbids at any level.
 *
 * And no status, no recommendation and nothing about whether the deal is worth
 * pursuing. Coverage is a count of facts, not a judgement about them.
 */
export const qualificationCoverageSchema = z
  .object({
    covered: z
      .array(
        z
          .object({
            area: z.enum(QUALIFICATION_AREAS),
            quote: z
              .string()
              .trim()
              .min(1, "Point at the client's own words")
              .max(400),
          })
          .strict(),
      )
      .max(QUALIFICATION_AREAS.length),
  })
  .strict();

export type QualificationCoverage = z.infer<typeof qualificationCoverageSchema>;

export function qualificationCoverageJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(qualificationCoverageSchema)) as Record<string, unknown>;
}

/**
 * What the sales agent may write as a follow-up.
 *
 * **One short line, in the language the client writes in, with no numbers.**
 *
 * ADM-61 puts anything client-facing behind a person *"with the ADM-11
 * follow-ups as the single exception"*. This is that exception, and it is the
 * only thing in this system an agent writes that a client will read without
 * anybody else reading it first.
 *
 * So the constraints are the ones that hold when nobody is looking:
 *
 * - **No digits.** A price is a number, a promised date is a number, a
 *   discount is a number. ADM-22 forbids an agent naming a price and ADM-61
 *   §5 forbids it promising a date it was not given — and the database refuses
 *   a digit outright, because at this surface a rule a constraint can check
 *   beats a rule a prompt asks for.
 * - **Short.** A follow-up that runs long is an agent explaining something,
 *   and explaining is the part it may not do.
 * - **Their language.** From `crm.contacts.preferred_language`, which is
 *   maintained from what they actually write (Doc 08 §8).
 *
 * There is no recipient, no schedule and no send: which sequence this belongs
 * to and when it goes are the worker's, and whether it goes at all is
 * `core.organizations.agent_writes_follow_ups`, which is off until an owner
 * turns it on.
 */
export const followUpDraftSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, 'Say something, or say nothing at all')
      .max(300, 'A follow-up is one line')
      .regex(/^[^0-9]*$/, 'No numbers: not a price, not a date, not a discount'),
  })
  .strict();

export type FollowUpDraft = z.infer<typeof followUpDraftSchema>;

export function followUpDraftJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(followUpDraftSchema)) as Record<string, unknown>;
}

/**
 * What the sales agent may say back to a client.
 *
 * **One short message, in their language, that asks rather than asserts.**
 *
 * ADM-91 (2026-08-22, the owner's own words: *"ai agent khud kare"*) widened
 * ADM-11 so that a reply to an inbound WhatsApp message reaches the client with
 * nobody reading it first. It is the second such path in AgencyOS and the first
 * inside a live conversation.
 *
 * ADM-91 changed **none** of ADM-61 §5's five absolutes, so the schema can
 * express nothing that would break one:
 *
 * - **No price, no amount, no discount.** ADM-22 leaves every price to a
 *   human. There is no field for one, and `crm.refuse_agent_money_talk`
 *   refuses a currency symbol or an amount at the row as well — because this
 *   is the surface where a sentence reaches a client with nobody in between.
 * - **No date, no commitment, no status.** Promising a delivery date it was
 *   not given is §5.2; there is nothing here to promise with.
 * - **Nothing that moves a record.** The reply is a message. It accepts no
 *   proposal, closes no deal and changes no lead.
 *
 * Doc 03 §5 asks the Sales Agent to *qualify* and *ask relevant questions*, and
 * Doc 09 §9 says not to interrogate a lead about what the conversation has
 * already answered — which is why the workflow hands it the areas still open
 * and asks for one question, not ten.
 */
export const clientReplySchema = z
  .object({
    reply: z
      .string()
      .trim()
      .min(1, 'Say something, or say nothing at all')
      // Long enough for a structured answer, and no longer. The first version
      // capped at 600, which is fine for "who will use it?" and refuses the
      // thing a client most often actually asks — *what features would an app
      // like this need* — whose honest answer is three headed lists. A cap is
      // not a style guide: how long a reply SHOULD be is the prompt's business
      // and depends on what was asked. This is only the line past which a
      // WhatsApp message stops being readable at all.
      .max(1200, 'This is a WhatsApp message, not a document')
      // At most one emoji, and none is the normal case. A model left to itself
      // opens with "Great! 😊" every time, which is the single clearest tell
      // that nobody is really there — the first live reply did exactly that.
      .refine(
        (v) => (v.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 1,
        'At most one emoji, and usually none',
      )
      .regex(
        /^(?!.*(₹|\$|\brs\.?\b|\binr\b|\busd\b))/is,
        'No prices: every price in AgencyOS is a human\'s (ADM-22)',
      )
      .regex(
        /^(?!.*\d[\d,]*\s*(k\b|lakh|lac|crore|rupees?|dollars?))/is,
        'No amounts: every price in AgencyOS is a human\'s (ADM-22)',
      )
      // A discount, which is its own absolute in ADM-61 §5 and was NOT held
      // here. "I can give you 20% discount" carries no currency and no amount
      // word, so both regexes above let it through — and it only ever failed
      // at the row, where `crm.states_a_price` catches it. The client never saw
      // one, and that is the half-a-check shape exactly: a rule held by two
      // layers and expressible in one. Composed, validated, refused, retried,
      // refused again.
      //
      // Deliberately not every percentage, and the exemption is the row's own:
      // "50% complete" is an honest sentence about progress and blocking it
      // would teach whoever hits it to route around the guard.
      .regex(
        /^(?!.*(\d+\s*%\s*(off|discount|less)|\bdiscount\s+of\s+\d))/is,
        'No discounts: offering one is ADM-61 §5, and not an agent\'s to offer',
      ),
    /**
     * Doc 09 §7 — *"Sales Agent must escalate high-risk/out-of-policy
     * requests"* — and §36 — *"AI must escalate uncertainty."* Both are listed
     * as guardrails and neither had a way to happen.
     *
     * A reason, or null. **The reply is still sent** when this is set: the
     * client asked for a person and hears that one is coming, which is the
     * whole point. What stops is every reply after it, until a human clears
     * the pause.
     *
     * Bounded and prose because it is read by whoever picks the thread up, on
     * a screen, under pressure.
     */
    handToHuman: z
      .string()
      .trim()
      .min(1, 'Say why a person is needed, or say null')
      .max(300, 'A sentence for whoever picks this up, not a report')
      .nullable(),
  })
  .strict();

export type ClientReply = z.infer<typeof clientReplySchema>;

export function clientReplyJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(clientReplySchema)) as Record<string, unknown>;
}

/**
 * What one image a client sent turns out to contain — brief 2026-08-22 §28.
 *
 * The one field that matters is `description`, and what it must be is stated
 * in the prompt rather than in the shape: what is in the picture, including
 * any words written in it, in the language they were written in (§29 —
 * *"Do not assume the image language is English"*).
 *
 * **There is no field here that can act.** No suggested requirement, no
 * proposed status, no price read off a competitor's screenshot. A screenshot
 * of somebody else's pricing page is the exact case where a model reading a
 * number and this system treating it as ours would be the worst possible
 * outcome — so the reading is prose, it lands in a column the transcript
 * labels as a reading, and every decision downstream is made from the
 * transcript by the same agents that were making it before. The absence is
 * the control.
 */
export const imageReadingSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1, 'Say what is in it, or say that you cannot tell')
      // Long enough for a screen full of text — a handwritten requirement list
      // or a feature grid is a legitimate thing to find in a photograph, and
      // §29 asks for the words in it, not a summary of them.
      .max(2000, 'A description, not a document'),
    /**
     * The language of the words IN the image, as a short tag, or null when it
     * contains no words at all.
     *
     * Separate from `crm.conversation_messages.language`, which is the
     * language the client wrote their message in. A client writing in English
     * can send a screenshot full of Hindi, and treating either as the other is
     * how a reply comes back in the wrong one.
     */
    textLanguage: z.string().trim().min(2).max(12).nullable(),
  })
  .strict();

export type ImageReading = z.infer<typeof imageReadingSchema>;

export function imageReadingJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(imageReadingSchema)) as Record<string, unknown>;
}

/**
 * Long runs of digits, removed from a description before it is stored.
 *
 * A photograph a client sends is not curated. It can be a screenshot of a
 * bank transfer, an invoice, a card, an Aadhaar — and the description is
 * durable, readable on an internal screen, and fed to a model on every
 * subsequent turn of the conversation. §27 of the brief is about not letting
 * one customer's information reach another; the cheapest way to honour it is
 * for the information not to be written down.
 *
 * **In code rather than in the schema, deliberately.** A refusal would fail
 * validation, fail the job, and retry — so a client who sent a payment
 * screenshot would be the one client the agent never answers. Redaction
 * cannot fail. The prompt asks for the same restraint; this is what holds when
 * the asking does not.
 *
 * Twelve is the threshold because a card is 13–19 digits and an account
 * number is longer, while a year, a price, a phone-shaped six and an OTP are
 * shorter. Spaces and hyphens inside a run are how these are actually
 * written, so they are part of the run rather than a way around it.
 */
export function redactLongDigitRuns(text: string): string {
  return text.replace(/\d[\d\s-]{10,}\d/g, (run) =>
    // Counted on the digits alone: "4111 1111 1111 1111" is sixteen digits
    // however it is spaced, and "12 - 15" is two numbers that happen to be
    // long enough to match the run pattern and must survive.
    run.replace(/\D/g, '').length >= 12 ? '[number removed]' : run,
  );
}
