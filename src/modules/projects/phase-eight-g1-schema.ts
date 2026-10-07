import { z } from 'zod';

/**
 * Phase 8 G1 form schemas: ONE zod schema per form a person submits. Pure (no 'use server', no database): the server actions parse with these BEFORE the
 * database is asked, so a malformed id or an out-of-range number is refused with a word and never sent to fail as a type error. Every bound here is the bound
 * the database door and its CHECK hold again; the database remains the authority.
 */

export const CHANNELS = ['whatsapp', 'email', 'portal', 'call', 'meeting'] as const;
export const PURPOSES = ['operational', 'relationship', 'commercial'] as const;
export const FEEDBACK_KINDS = ['feedback', 'goal'] as const;
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const;
/** The sources a PERSON may record feedback from (the portal is the client's own door). */
export const STAFF_FEEDBACK_SOURCES = ['call', 'meeting', 'email', 'whatsapp', 'survey', 'other'] as const;
export const DESIGNATIONS = ['strategic', 'vip'] as const;
export const SCOPE_RELATIONS = ['inside_scope', 'excluded', 'outside_scope', 'unclear'] as const;
export const HANDOFF_TARGETS = ['developer', 'quality_assurance'] as const;
export const HANDOFF_DECISIONS = ['acknowledged', 'completed', 'declined'] as const;

const uuid = z.uuid({ message: 'A selected record is not valid.' });
const text = (min: number, max: number, what: string) =>
  z.string({ message: `${what} is required.` }).trim().min(min, `${what} must be at least ${min} characters.`).max(max, `${what} must be at most ${max} characters.`);
const optionalText = (max: number, what: string) => z.string().trim().min(1).max(max, `${what} must be at most ${max} characters.`).optional();
const optionalUuid = uuid.optional();
const rating = z.string().regex(/^[1-5]$/, 'A rating is a whole number from 1 to 5.').transform(Number).optional();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'The date is not valid.').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'The date is not valid.').optional();
const language = z.string().regex(/^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$/, 'A language is a code such as en or hi.').optional();
const channelList = z.array(z.enum(CHANNELS)).max(5);

/**
 * Read a FormData into a plain object: a blank field is ABSENT (so an optional field may be left empty), a checkbox is a boolean, and the avoid-channel
 * checkboxes are a list. Nothing is guessed: anything else stays the string the person typed.
 */
export function formFields(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...fd.keys()])) {
    if (key === 'avoidChannels') {
      out[key] = fd.getAll(key).map(String);
      continue;
    }
    const raw = String(fd.get(key) ?? '').trim();
    if (raw !== '') out[key] = raw;
  }
  if (!('avoidChannels' in out)) out.avoidChannels = [];
  out.clientSafe = fd.get('clientSafe') === 'on' || fd.get('clientSafe') === 'true';
  return out;
}

// ── feedback ────────────────────────────────────────────────────────────────────────────────────────────────

const feedbackCore = {
  kind: z.enum(FEEDBACK_KINDS, { message: 'Choose feedback or a goal.' }),
  sentiment: z.enum(SENTIMENTS).optional(),
  rating,
  body: text(10, 4000, 'The wording'),
  projectId: optionalUuid,
};
/** A feedback is how the client felt; a goal is a wish with no score. Held again by the database. */
const feedbackShape = <T extends { kind: 'feedback' | 'goal'; sentiment?: string; rating?: number }>(v: T, ctx: z.RefinementCtx) => {
  if (v.kind === 'feedback' && !v.sentiment) ctx.addIssue({ code: 'custom', path: ['sentiment'], message: 'Feedback needs how it felt: positive, neutral, negative or mixed.' });
  if (v.kind === 'goal' && (v.sentiment || v.rating !== undefined)) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'A goal is a wish, not a score: it carries no sentiment and no rating.' });
};

export const recordFeedbackSchema = z
  .object({ clientId: uuid, source: z.enum(STAFF_FEEDBACK_SOURCES, { message: 'Choose where this came from.' }), occurredOn: day, ...feedbackCore })
  .superRefine(feedbackShape);
export type RecordFeedbackInput = z.infer<typeof recordFeedbackSchema>;

export const acknowledgeFeedbackSchema = z.object({ clientId: uuid, feedbackId: uuid, note: text(5, 1000, 'The note') });
export type AcknowledgeFeedbackInput = z.infer<typeof acknowledgeFeedbackSchema>;

export const portalFeedbackSchema = z.object(feedbackCore).superRefine(feedbackShape);
export type PortalFeedbackInput = z.infer<typeof portalFeedbackSchema>;

// ── designation, preferences, cadence ───────────────────────────────────────────────────────────────────────

export const setDesignationSchema = z.object({
  clientId: uuid,
  designation: z.enum(DESIGNATIONS, { message: 'Choose strategic or VIP.' }),
  criteria: text(10, 1000, 'The criteria'),
  reason: text(10, 1000, 'The reason'),
});
export type SetDesignationInput = z.infer<typeof setDesignationSchema>;

export const endDesignationSchema = z.object({ clientId: uuid, designation: z.enum(DESIGNATIONS, { message: 'Choose strategic or VIP.' }), reason: text(5, 1000, 'The reason') });
export type EndDesignationInput = z.infer<typeof endDesignationSchema>;

const preferenceCore = {
  preferredChannel: z.enum(CHANNELS).optional(),
  language,
  avoidChannels: channelList,
  note: optionalText(500, 'The note'),
};
const notBoth = <T extends { preferredChannel?: string; avoidChannels: string[] }>(v: T, ctx: z.RefinementCtx) => {
  if (v.preferredChannel && v.avoidChannels.includes(v.preferredChannel)) ctx.addIssue({ code: 'custom', path: ['preferredChannel'], message: 'A channel cannot be both preferred and avoided.' });
};

export const contactPreferencesSchema = z.object({ clientId: uuid, preferredContactId: optionalUuid, ...preferenceCore }).superRefine(notBoth);
export type ContactPreferencesInput = z.infer<typeof contactPreferencesSchema>;

export const portalPreferencesSchema = z.object({ projectId: uuid, ...preferenceCore }).superRefine(notBoth);
export type PortalPreferencesInput = z.infer<typeof portalPreferencesSchema>;

const gap = z.string().regex(/^\d{1,3}$/, 'The gap is a whole number of days from 1 to 365.').transform(Number).refine((n) => n >= 1 && n <= 365, 'The gap is a whole number of days from 1 to 365.');
/** `all` (or blank) means every channel: the database takes a null channel. */
const ruleChannel = z.enum([...CHANNELS, 'all']).optional();

export const setCadenceRuleSchema = z.object({ clientId: optionalUuid, purpose: z.enum(PURPOSES, { message: 'Choose a purpose.' }), channel: ruleChannel, minGapDays: gap });
export type SetCadenceRuleInput = z.infer<typeof setCadenceRuleSchema>;

export const clearCadenceRuleSchema = z.object({ clientId: optionalUuid, purpose: z.enum(PURPOSES, { message: 'Choose a purpose.' }), channel: ruleChannel });
export type ClearCadenceRuleInput = z.infer<typeof clearCadenceRuleSchema>;

// ── knowledge ───────────────────────────────────────────────────────────────────────────────────────────────

export const knowledgeProposeSchema = z.object({
  key: z.string({ message: 'The key is required.' }).trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/, 'The key is lower-case letters, digits and hyphens, 3 to 80 characters.'),
  title: text(3, 200, 'The title'),
  body: text(20, 8000, 'The article'),
  clientSafe: z.boolean(),
});
export type KnowledgeProposeInput = z.infer<typeof knowledgeProposeSchema>;
export const knowledgeApproveSchema = z.object({ articleId: uuid });
export const knowledgeRetireSchema = z.object({ articleId: uuid, reason: text(5, 1000, 'The reason') });
export const knowledgeCiteSchema = z.object({ ticketId: uuid, articleId: uuid });

// ── scope reference, hand-off ───────────────────────────────────────────────────────────────────────────────

export const scopeReferenceSchema = z
  .object({ ticketId: uuid, relation: z.enum(SCOPE_RELATIONS, { message: 'Choose how the ticket relates to the scope.' }), scopeItemId: optionalUuid, note: text(10, 1000, 'The note') })
  .superRefine((v, ctx) => {
    if ((v.relation === 'inside_scope' || v.relation === 'excluded') && !v.scopeItemId) ctx.addIssue({ code: 'custom', path: ['scopeItemId'], message: 'Inside scope and excluded must name the scope item they rest on.' });
    if (v.relation === 'outside_scope' && v.scopeItemId) ctx.addIssue({ code: 'custom', path: ['scopeItemId'], message: 'Outside scope names no scope item.' });
  });
export type ScopeReferenceInput = z.infer<typeof scopeReferenceSchema>;
export const scopeConfirmSchema = z.object({ referenceId: uuid });

export const handoffRequestSchema = z.object({ ticketId: uuid, target: z.enum(HANDOFF_TARGETS, { message: 'Choose a developer or quality assurance.' }), reason: text(10, 1000, 'The reason') });
export type HandoffRequestInput = z.infer<typeof handoffRequestSchema>;
export const handoffSettleSchema = z
  .object({ requestId: uuid, decision: z.enum(HANDOFF_DECISIONS, { message: 'Choose acknowledged, completed or declined.' }), note: optionalText(1000, 'The note') })
  .superRefine((v, ctx) => {
    if ((v.decision === 'completed' || v.decision === 'declined') && (v.note ?? '').length < 5) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Completing or declining needs a note of at least five characters.' });
  });
export type HandoffSettleInput = z.infer<typeof handoffSettleSchema>;

// ── discovery brief ─────────────────────────────────────────────────────────────────────────────────────────

export const discoveryReviewSchema = z.object({ briefId: uuid, note: optionalText(500, 'The note') });
export type DiscoveryReviewInput = z.infer<typeof discoveryReviewSchema>;
