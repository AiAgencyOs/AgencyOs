import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { asRows, firstRow, text, userRpc, whole } from '@/lib/db/p1o-rpc';
import type { DraftLanguage } from '@/lib/scheduling/p1r-messages';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { sendClientMessage } from './service';

/**
 * Round 4, Scheduler: the client-facing scheduling messages are DRAFTS a person sends (P1-SCHED-011/024/025/027/029), plus the reminder numbers, the provider
 * checks and the overlap rule that sit beside them.
 *
 * Nothing in this file sends on its own. Composing a draft is `crm.p1r_save_scheduling_draft`; sending is a signed-in person pressing send, which goes through the
 * ordinary outbound door (`sendClientMessage`: consent, the 24-hour window and the delivery record all apply) and only then records that a person sent it. A
 * service-role compose is allowed (an agent or a job may draft); the database refuses the service role the send record.
 */
export type DraftKind = 'proposal' | 'confirmation' | 'no_availability' | 'clarification';

const SAY: Record<string, string> = {
  forbidden: 'You cannot do that for this organisation.',
  person_required: 'A signed-in person has to do that.',
  unknown_meeting: 'That meeting no longer exists.',
  unknown_draft: 'That draft no longer exists.',
  wrong_state: 'The meeting is in a state this message does not fit, so no draft was kept.',
  bad_body: 'A message needs words, and at most 1,500 characters.',
  bad_language: 'That language is not one the drafts cover.',
  not_a_draft: 'That draft was already sent or discarded.',
  missing_reason: 'A reason is required.',
  bad_value: 'Say whether overlapping meetings are prevented.',
};

/** As the signed-in person (the propose/book screens). Best effort by design: a draft that could not be kept never undoes the booking it describes. */
export async function saveSchedulingDraft(input: { meetingId: string; kind: DraftKind; language: DraftLanguage; body: string; flagId?: string | null }): Promise<Result<string>> {
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1r_save_scheduling_draft', { p_meeting_id: input.meetingId, p_kind: input.kind, p_language: input.language, p_body: input.body, p_flag_id: input.flagId ?? null });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'saveSchedulingDraft', detail: error.message }));
    return err('INTERNAL', 'The draft could not be kept.');
  }
  const row = firstRow(data);
  const outcome = String(row?.outcome ?? '');
  return outcome === 'saved' || outcome === 'replaced' ? ok(String(row?.draft_id ?? '')) : err('VALIDATION', SAY[outcome] ?? 'The database refused that draft.');
}

export type SchedulingDraft = {
  draftId: string; meetingId: string; leadId: string; conversationId: string | null; kind: DraftKind; language: string; body: string; meetingStatus: string; createdAt: string;
};

export async function listOpenSchedulingDrafts(): Promise<SchedulingDraft[]> {
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1r_open_scheduling_drafts', { p_limit: 100 });
  if (error) unreadable('listOpenSchedulingDrafts', error);
  return asRows(data).map((r) => ({
    draftId: String(r.draft_id), meetingId: String(r.meeting_id), leadId: String(r.lead_id), conversationId: text(r.conversation_id), kind: String(r.kind) as DraftKind,
    language: String(r.language), body: String(r.body), meetingStatus: String(r.meeting_status), createdAt: String(r.created_at),
  }));
}

/**
 * A person sends a draft, possibly after editing it. The words go through the ordinary outbound door first; only then is the send recorded against the draft. If the
 * message left and the record failed, the person is told plainly not to send it again.
 */
export async function sendSchedulingDraft(draftId: string, body: string): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'Your role cannot message clients.');
  const words = body.trim();
  if (words.length === 0 || words.length > 1500) return err('VALIDATION', SAY.bad_body as string);
  const drafts = await listOpenSchedulingDrafts();
  const draft = drafts.find((d) => d.draftId === draftId);
  if (!draft) return err('NOT_FOUND', 'That draft is not open any more: it was already sent or discarded.');
  if (!draft.conversationId) return err('CONFLICT', 'This meeting has no conversation with the client to send into. Copy the words and send them from the lead.');

  const sent = await sendClientMessage({ conversationId: draft.conversationId, body: words, idempotencyKey: `sched-draft:${draft.draftId}` });
  if (!sent.ok) return sent;

  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1r_record_scheduling_draft_sent', { p_draft_id: draft.draftId, p_message_id: sent.data.messageId });
  const outcome = String(firstRow(data)?.outcome ?? '');
  if (error || outcome !== 'recorded') {
    console.error(JSON.stringify({ level: 'error', scope: 'sendSchedulingDraft', detail: error?.message ?? outcome }));
    return err('INTERNAL', 'The message was sent, but the draft could not be marked sent. Do not send it again: discard the draft.');
  }
  return ok(sent.data.delivered ? 'Sent to the client.' : 'Recorded in the conversation; the provider has not confirmed delivery yet.');
}

export async function discardSchedulingDraft(draftId: string, reason: string): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'Your role cannot discard a draft.');
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1r_discard_scheduling_draft', { p_draft_id: draftId, p_reason: reason });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'discardSchedulingDraft', detail: error.message }));
    return err('INTERNAL', 'Could not discard that.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'discarded' ? ok('Discarded.') : err('VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

// ── the numbers beside them ────────────────────────────────────────────────
export type ReminderMetrics = {
  jobs: number; jobsQueued: number; jobsDone: number; jobsFailed: number; jobsDead: number;
  messages: number; handedOff: number; sendFailed: number; sendPending: number; delivered: number; read: number; wireFailed: number; awaitingReceipt: number;
  deliveryRate: number | null; failureRate: number | null;
};

export async function readReminderMetrics(): Promise<ReminderMetrics | null> {
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1r_reminder_metrics', {});
  if (error) unreadable('readReminderMetrics', error);
  const r = firstRow(data);
  if (!r) return null;
  const f = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    jobs: whole(r.jobs), jobsQueued: whole(r.jobs_queued), jobsDone: whole(r.jobs_done), jobsFailed: whole(r.jobs_failed), jobsDead: whole(r.jobs_dead),
    messages: whole(r.messages), handedOff: whole(r.handed_off), sendFailed: whole(r.send_failed), sendPending: whole(r.send_pending), delivered: whole(r.delivered),
    read: whole(r.read), wireFailed: whole(r.wire_failed), awaitingReceipt: whole(r.awaiting_receipt), deliveryRate: f(r.delivery_rate), failureRate: f(r.failure_rate),
  };
}

export type ProviderCheckSummary = { checked: number; inSync: number; conflicts: number; unreadable: number; lastCheckedAt: string | null };

export async function readProviderCheckSummary(): Promise<ProviderCheckSummary | null> {
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1r_provider_check_summary', { p_days: 30 });
  if (error) unreadable('readProviderCheckSummary', error);
  const r = firstRow(data);
  if (!r) return null;
  return { checked: whole(r.checked), inSync: whole(r.in_sync), conflicts: whole(r.conflicts), unreadable: whole(r.unreadable), lastCheckedAt: text(r.last_checked_at) };
}

export type OverlapRule = { preventOverlap: boolean; reason: string | null; setAt: string | null; configured: boolean };

export async function readOverlapRule(): Promise<OverlapRule | null> {
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1r_overlap_rule_for', {});
  if (error) unreadable('readOverlapRule', error);
  const r = firstRow(data);
  if (!r) return null;
  return { preventOverlap: r.prevent_overlap === true, reason: text(r.reason), setAt: text(r.set_at), configured: r.configured === true };
}

export async function setOverlapRule(prevent: boolean, reason: string): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings') || !context.organizationId) return err('FORBIDDEN', 'Only an owner or ops admin can change this.');
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1r_set_overlap_rule', { p_organization_id: context.organizationId, p_prevent: prevent, p_reason: reason });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setOverlapRule', detail: error.message }));
    return err('INTERNAL', 'Could not save that.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'set' ? ok(prevent ? 'On. A booking that overlaps another booked meeting is refused.' : 'Off. Overlapping meetings are allowed.') : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}
