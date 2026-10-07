'use server';

import { revalidatePath } from 'next/cache';
import type { ZodType } from 'zod';

import { requireClient, requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import {
  acknowledgeFeedbackSchema,
  clearCadenceRuleSchema,
  contactPreferencesSchema,
  discoveryReviewSchema,
  endDesignationSchema,
  formFields,
  handoffRequestSchema,
  handoffSettleSchema,
  knowledgeApproveSchema,
  knowledgeCiteSchema,
  knowledgeProposeSchema,
  knowledgeRetireSchema,
  portalFeedbackSchema,
  portalPreferencesSchema,
  recordFeedbackSchema,
  scopeConfirmSchema,
  scopeReferenceSchema,
  setCadenceRuleSchema,
  setDesignationSchema,
} from './phase-eight-g1-schema';

/**
 * Phase 8A gaps log 1 actions: ONE server action over a WHITELIST of database doors for staff, and ONE for the signed-in client. The same shape as the Phase 8D
 * action. Nothing here decides: the form is parsed (a malformed id or number is refused with a word and never sent), then the door checks the role, the state and
 * the tenant under its own lock and its answer is reported as written. A door answer that is not the success word is an ERROR, never swallowed. Nothing here sends
 * anything to a client, quotes, prices or discounts. No agent door is reachable from here.
 */

type Parsed = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Door = { schema: ZodType<Parsed>; rpc: string; args: (p: Parsed) => Record<string, unknown>; ok: readonly string[]; paths?: (p: Parsed) => string[] };

const channelOrNull = (v: unknown) => (v === undefined || v === 'all' ? null : v);

const BASE_PATHS = ['/projects/customer-success/next-actions', '/projects/customer-success/knowledge'];
const clientPaths = (p: Parsed) => (typeof p.clientId === 'string' ? [`/clients/${p.clientId}/customer-360`] : []);

const STAFF_DOORS: Record<string, Door> = {
  feedback_record: {
    schema: recordFeedbackSchema as unknown as ZodType<Parsed>, rpc: 'record_client_feedback', ok: ['recorded'], paths: clientPaths,
    args: (p) => ({ p_client_account_id: p.clientId, p_kind: p.kind, p_source: p.source, p_sentiment: p.sentiment ?? null, p_rating: p.rating ?? null, p_body: p.body, p_project_id: p.projectId ?? null, p_occurred_on: p.occurredOn ?? null }),
  },
  feedback_ack: { schema: acknowledgeFeedbackSchema as unknown as ZodType<Parsed>, rpc: 'acknowledge_client_feedback', ok: ['acknowledged'], paths: clientPaths, args: (p) => ({ p_feedback_id: p.feedbackId, p_note: p.note }) },
  designation_set: {
    schema: setDesignationSchema as unknown as ZodType<Parsed>, rpc: 'set_client_designation', ok: ['designated'], paths: clientPaths,
    args: (p) => ({ p_client_account_id: p.clientId, p_designation: p.designation, p_criteria: p.criteria, p_reason: p.reason }),
  },
  designation_end: {
    schema: endDesignationSchema as unknown as ZodType<Parsed>, rpc: 'end_client_designation', ok: ['ended'], paths: clientPaths,
    args: (p) => ({ p_client_account_id: p.clientId, p_designation: p.designation, p_reason: p.reason }),
  },
  preferences_set: {
    schema: contactPreferencesSchema as unknown as ZodType<Parsed>, rpc: 'set_client_contact_preferences', ok: ['set'], paths: clientPaths,
    args: (p) => ({ p_client_account_id: p.clientId, p_preferred_channel: p.preferredChannel ?? null, p_language: p.language ?? null, p_avoid_channels: p.avoidChannels, p_preferred_contact_id: p.preferredContactId ?? null, p_note: p.note ?? null }),
  },
  cadence_set: {
    schema: setCadenceRuleSchema as unknown as ZodType<Parsed>, rpc: 'set_communication_cadence_rule', ok: ['set'], paths: clientPaths,
    args: (p) => ({ p_purpose: p.purpose, p_channel: channelOrNull(p.channel), p_min_gap_days: p.minGapDays }),
  },
  cadence_clear: {
    schema: clearCadenceRuleSchema as unknown as ZodType<Parsed>, rpc: 'clear_communication_cadence_rule', ok: ['cleared'], paths: clientPaths,
    args: (p) => ({ p_purpose: p.purpose, p_channel: channelOrNull(p.channel) }),
  },
  knowledge_propose: { schema: knowledgeProposeSchema as unknown as ZodType<Parsed>, rpc: 'propose_knowledge_article', ok: ['proposed'], args: (p) => ({ p_key: p.key, p_title: p.title, p_body: p.body, p_client_safe: p.clientSafe }) },
  knowledge_approve: { schema: knowledgeApproveSchema as unknown as ZodType<Parsed>, rpc: 'approve_knowledge_article', ok: ['approved'], args: (p) => ({ p_article_id: p.articleId }) },
  knowledge_retire: { schema: knowledgeRetireSchema as unknown as ZodType<Parsed>, rpc: 'retire_knowledge_article', ok: ['retired'], args: (p) => ({ p_article_id: p.articleId, p_reason: p.reason }) },
  knowledge_cite: { schema: knowledgeCiteSchema as unknown as ZodType<Parsed>, rpc: 'cite_knowledge_for_ticket', ok: ['cited'], args: (p) => ({ p_ticket_id: p.ticketId, p_article_id: p.articleId }) },
  scope_record: {
    schema: scopeReferenceSchema as unknown as ZodType<Parsed>, rpc: 'record_ticket_scope_reference', ok: ['recorded'],
    args: (p) => ({ p_ticket_id: p.ticketId, p_relation: p.relation, p_scope_item_id: p.scopeItemId ?? null, p_note: p.note }),
  },
  scope_confirm: { schema: scopeConfirmSchema as unknown as ZodType<Parsed>, rpc: 'confirm_ticket_scope_reference', ok: ['confirmed'], args: (p) => ({ p_reference_id: p.referenceId }) },
  handoff_request: { schema: handoffRequestSchema as unknown as ZodType<Parsed>, rpc: 'request_ticket_handoff', ok: ['requested'], args: (p) => ({ p_ticket_id: p.ticketId, p_target: p.target, p_reason: p.reason }) },
  handoff_settle: { schema: handoffSettleSchema as unknown as ZodType<Parsed>, rpc: 'settle_ticket_handoff', ok: ['acknowledged', 'completed', 'declined'], args: (p) => ({ p_request_id: p.requestId, p_decision: p.decision, p_note: p.note ?? null }) },
  brief_review: { schema: discoveryReviewSchema as unknown as ZodType<Parsed>, rpc: 'review_discovery_brief', ok: ['reviewed'], args: (p) => ({ p_brief_id: p.briefId, p_note: p.note ?? null }) },
};

const PORTAL_DOORS: Record<string, Door> = {
  feedback_submit: {
    schema: portalFeedbackSchema as unknown as ZodType<Parsed>, rpc: 'submit_client_feedback', ok: ['submitted'],
    args: (p) => ({ p_kind: p.kind, p_sentiment: p.sentiment ?? null, p_rating: p.rating ?? null, p_body: p.body, p_project_id: p.projectId ?? null }),
  },
  preferences_set: {
    schema: portalPreferencesSchema as unknown as ZodType<Parsed>, rpc: 'set_my_contact_preferences', ok: ['set'],
    args: (p) => ({ p_preferred_channel: p.preferredChannel ?? null, p_language: p.language ?? null, p_avoid_channels: p.avoidChannels, p_note: p.note ?? null }),
  },
};

const WORDS: Record<string, string> = {
  recorded: 'Recorded. Nothing was sent by this.',
  submitted: 'Thank you. Your message has gone to your project contact.',
  acknowledged: 'Acknowledged.',
  designated: 'Designation saved with the rule and reason you gave.',
  ended: 'Designation ended. The record stays.',
  set: 'Saved.',
  cleared: 'Cleared. There is no longer a rule for that.',
  proposed: 'Saved as a draft. It is not an approved answer until a different Admin approves it.',
  approved: 'Approved. It is now the answer Support may cite.',
  retired: 'Retired. It stays on record and can no longer be cited.',
  cited: 'Cited on the ticket.',
  confirmed: 'Confirmed.',
  requested: 'Requested. No task was created: a person picks it up.',
  completed: 'Marked completed.',
  declined: 'Marked declined.',
  reviewed: 'Marked reviewed. Nothing was sent.',
  not_authorized: 'You do not have permission to do this.',
  not_a_client: 'This is only for a client signed in to its portal.',
  no_actor: 'You are not signed in as a member.',
  not_found: 'That record was not found.',
  note_required: 'A note is required (at least five characters).',
  reason_required: 'A reason is required.',
  criteria_required: 'Say the rule the designation was decided under.',
  contains_secret: 'That looks like a secret (a password or key). Take it out.',
  names_a_price: 'An article names no price or discount. Take that wording out.',
  author_cannot_approve: 'The author cannot approve their own article. Another Admin must.',
  not_a_draft: 'That is no longer a draft.',
  draft_exists: 'There is already an open draft of that article. Approve or retire it first.',
  article_not_approved: 'Only an approved article can be cited.',
  already_cited: 'That article is already cited on this ticket.',
  already_requested: 'There is already a live request of that kind for this ticket.',
  already_acknowledged: 'That was already acknowledged.',
  already_settled: 'That request is already settled.',
  already_designated: 'That client already has this designation.',
  already_confirmed: 'That is already confirmed.',
  already_recorded: 'That is already recorded.',
  already_reviewed: 'That brief was already reviewed.',
  classification_does_not_need_a_developer: 'Only a classified fault or maintenance ticket goes to a developer.',
  nothing_to_verify_yet: 'QA is asked once the work is in progress.',
  ticket_is_finished: 'That ticket is finished.',
  no_approved_scope_version: 'The workspace has no approved scope version to compare against.',
  item_not_in_the_approved_scope: 'That scope item is not in the approved scope version.',
  item_is_not_included: 'That scope item is not an included one.',
  item_is_not_excluded: 'That scope item is not an explicit exclusion.',
  prefers_and_avoids_the_same_channel: 'A channel cannot be both preferred and avoided.',
  out_of_range: 'That number is outside the allowed range.',
};

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function run(doors: Record<string, Door>, formData: FormData): Promise<FormState> {
  const name = String(formData.get('door') ?? '');
  const door = Object.prototype.hasOwnProperty.call(doors, name) ? doors[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };
  const parsed = door.schema.safeParse(formFields(formData));
  if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  const supabase = await createClient();
  const rpc = (supabase.schema('projects') as unknown as { rpc: Rpc }).rpc.bind(supabase.schema('projects'));
  const { data, error } = await rpc(door.rpc, door.args(parsed.data));
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  if (!door.ok.includes(outcome)) return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
  for (const path of [...BASE_PATHS, ...(door.paths ? door.paths(parsed.data) : [])]) revalidatePath(path);
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}

/** Staff: one action over the whitelisted doors above. The database refuses by role (Admin-only doors included). */
export async function phaseEightG1Action(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this.' };
  return run(STAFF_DOORS, formData);
}

/** The signed-in client: only its own feedback and contact preferences. */
export async function phaseEightG1PortalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireClient();
  const result = await run(PORTAL_DOORS, formData);
  const project = String(formData.get('projectId') ?? '');
  if (/^[0-9a-f-]{36}$/i.test(project)) {
    revalidatePath(`/portal/${project}/feedback`);
  }
  return result;
}
