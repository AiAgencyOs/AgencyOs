import { z } from 'zod';

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

/**
 * JSON Schema handed to the provider for constrained decoding. Derived from
 * the Zod schema so the two cannot drift.
 */
export function requirementJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(requirementPayloadSchema) as Record<string, unknown>;
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
  // to copy. Naming it explicitly rather than hoping the format is guessed:
  // a reply that quotes it is correlated to this request and nothing else.
  lines.push(`Reply quoting ${event.reference}.`);

  return lines.join('\n');
}
