import { z } from 'zod';

import type { createAdminClient } from '@/lib/db/admin';
import { reviewQuoteReply, type QuoteReplyClass, type ReplyClassifier } from '@/modules/sales/p1o-quote-reply';

import type { HandlerResult } from './handlers';
import { routeMeetingIntent, type FlagKind, type IntentClassifier } from './p1o-meeting-intent';

/**
 * Two readers of a client's message (subscribers to `message.received`), both of which only ever hand work to a PERSON:
 *   * `routeSchedulingMessage`  a reschedule, cancel, availability or reminder message becomes a flag on the meeting (`crm.p1o_flag_meeting`).
 *   * `reviewQuoteReplyMessage` a reply to a sent quotation is classified (`sales.p1o_record_quote_response`, which refuses the class "accepted"), and a bare "okay"
 *     with several versions open raises a clarification (`sales.p1o_raise_acceptance_clarification`) with a drafted question for a person to send.
 * Row authority over event payload: the event names a message; each handler re-reads it for the JOB's organisation and works from the row. Neither sends anything
 * to the client, books, cancels or records an acceptance. The classifiers default to deterministic keyword rules, so they run with no funded model; a
 * model-backed classifier can be injected (that run is MANUAL_EXTERNAL).
 */

type Admin = ReturnType<typeof createAdminClient>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export type MessageJob = { id: string; organization_id: string; payload: { subjectId?: string | null } | null; correlation_id: string | null };

const messageId = z.uuid();

type Message = { id: string; body: string; conversationId: string; language: string | null };
type Read<T> = { value: T | null; error: string | null };

async function readClientMessage(admin: Admin, organizationId: string, id: string): Promise<Read<Message & { leadId: string | null }>> {
  const { data, error } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('id, body, conversation_id, language, author_type')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) return { value: null, error: error.message };
  if (!data || (data as { author_type: string }).author_type !== 'client') return { value: null, error: null };
  const m = data as { id: string; body: string | null; conversation_id: string; language: string | null };
  const conv = await admin.schema('crm').from('conversations').select('lead_id').eq('id', m.conversation_id).eq('organization_id', organizationId).maybeSingle();
  if (conv.error) return { value: null, error: conv.error.message };
  return { value: { id: m.id, body: m.body ?? '', conversationId: m.conversation_id, language: m.language, leadId: (conv.data as { lead_id: string | null } | null)?.lead_id ?? null }, error: null };
}

const rpc = (admin: Admin, schema: 'crm' | 'sales'): Rpc => (fn, args) => (admin.schema(schema as never) as unknown as { rpc: Rpc }).rpc(fn, args);
const firstOutcome = (v: unknown): string => String(((Array.isArray(v) ? v[0] : v) as { outcome?: unknown } | null)?.outcome ?? '');
const notMine = (detail: string): HandlerResult => ({ status: 'succeeded', outcome: 'not_mine', detail });

export async function routeSchedulingMessage(admin: Admin, job: MessageJob, deps: { classify?: IntentClassifier } = {}): Promise<HandlerResult> {
  const id = messageId.safeParse(job.payload?.subjectId);
  if (!id.success) return { status: 'failed', permanent: true, detail: 'malformed message.received event: no message id' };
  const read = await readClientMessage(admin, job.organization_id, id.data);
  if (read.error) return { status: 'failed', permanent: false, detail: `could not read the message: ${read.error}` };
  if (!read.value) return notMine('not a client message, or it no longer exists');
  if (!read.value.leadId) return notMine('the conversation has no lead, so there is no meeting to speak of');

  const meetings = await admin
    .schema('crm')
    .from('meetings')
    .select('id, status, confirmed_start_at')
    .eq('organization_id', job.organization_id)
    .eq('lead_id', read.value.leadId)
    .in('status', ['requested', 'proposed', 'booked']);
  if (meetings.error) return { status: 'failed', permanent: false, detail: `could not read the lead's meetings: ${meetings.error.message}` };

  const flags = rpc(admin, 'crm');
  const routed = await routeMeetingIntent(
    { text: read.value.body, meetings: ((meetings.data ?? []) as Array<{ id: string; status: string; confirmed_start_at: string | null }>).map((m) => ({ id: m.id, status: m.status, confirmedStartAt: m.confirmed_start_at })) },
    {
      classify: deps.classify,
      flag: async (a) => {
        const { data, error } = await flags('p1o_flag_meeting', { p_meeting_id: a.meetingId, p_kind: a.kind satisfies FlagKind, p_note: a.note, p_candidate_meeting_ids: a.candidateMeetingIds });
        if (error) throw new Error(error.message);
        return { outcome: firstOutcome(data) };
      },
    },
  ).catch((e: unknown) => ({ failed: e instanceof Error ? e.message : 'the flag could not be recorded' }) as const);

  if ('failed' in routed) return { status: 'failed', permanent: false, detail: routed.failed };
  if (!routed.routed) return notMine(routed.reason);
  return { status: 'succeeded', outcome: routed.outcome === 'already_open' ? 'already_flagged' : 'flagged', detail: `${routed.kind} flagged for a person on meeting ${routed.meetingId}` };
}

export async function reviewQuoteReplyMessage(admin: Admin, job: MessageJob, deps: { classify?: ReplyClassifier } = {}): Promise<HandlerResult> {
  const id = messageId.safeParse(job.payload?.subjectId);
  if (!id.success) return { status: 'failed', permanent: true, detail: 'malformed message.received event: no message id' };
  const read = await readClientMessage(admin, job.organization_id, id.data);
  if (read.error) return { status: 'failed', permanent: false, detail: `could not read the message: ${read.error}` };
  if (!read.value) return notMine('not a client message, or it no longer exists');
  if (!read.value.leadId) return notMine('the conversation has no lead');

  const opps = await admin.schema('sales').from('opportunities').select('id').eq('organization_id', job.organization_id).eq('lead_id', read.value.leadId).not('stage', 'in', '("won","lost")');
  if (opps.error) return { status: 'failed', permanent: false, detail: `could not read the deal: ${opps.error.message}` };
  const opportunity = (opps.data as Array<{ id: string }> | null)?.[0];
  if (!opportunity) return notMine('no open deal on this lead');

  const sent = await admin.schema('sales').from('proposals').select('id, version').eq('organization_id', job.organization_id).eq('opportunity_id', opportunity.id).eq('status', 'sent').order('version', { ascending: false });
  if (sent.error) return { status: 'failed', permanent: false, detail: `could not read the sent quotations: ${sent.error.message}` };
  const open = (sent.data ?? []) as Array<{ id: string; version: number }>;
  if (open.length === 0) return notMine('no quotation is open with the client');

  const quotes = rpc(admin, 'sales');
  const language = read.value.language === 'hinglish' ? 'hinglish' : 'en';
  let reviewed;
  try {
    reviewed = await reviewQuoteReply(
      { text: read.value.body, proposalId: (open[0] as { id: string }).id, messageRef: read.value.id, openVersions: open.map((o) => o.version), language },
      {
        classify: deps.classify,
        record: async (a: { proposalId: string; responseClass: QuoteReplyClass; messageRef: string | null; note: string }) => {
          const { data, error } = await quotes('p1o_record_quote_response', { p_proposal_id: a.proposalId, p_class: a.responseClass, p_message_ref: a.messageRef, p_note: a.note });
          if (error) throw new Error(error.message);
          return { outcome: firstOutcome(data) };
        },
      },
    );
    if (reviewed.acceptance.kind === 'ambiguous') {
      const { error } = await quotes('p1o_raise_acceptance_clarification', { p_opportunity_id: opportunity.id, p_message_ref: read.value.id });
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    return { status: 'failed', permanent: false, detail: e instanceof Error ? e.message : 'the reply could not be recorded' };
  }

  if (reviewed.acceptance.kind === 'ambiguous') return { status: 'succeeded', outcome: 'clarification_raised', detail: 'a reply that reads as yes did not name which of several open versions; a person was asked to ask' };
  if (reviewed.needsPersonToRecordAcceptance) return { status: 'succeeded', outcome: 'acceptance_for_a_person', detail: 'the reply reads as an acceptance; a person records it with evidence' };
  if (reviewed.recorded) return { status: 'succeeded', outcome: 'classified', detail: `reply recorded as ${reviewed.recorded.replyClass}` };
  return notMine('the reply is not about the quotation');
}
