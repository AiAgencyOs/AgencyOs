import 'server-only';

import { OUTBOUND_PAUSED } from './kill-switch';
import { deliverQueuedText, type QueuedOutbound } from './deliver-text';

type Db = Parameters<typeof deliverQueuedText>[0];

/**
 * One fixed, code-written message to a client thread, sent AT MOST ONCE.
 *
 * The pattern the hand-over acknowledgement found the hard way (it went three
 * times when three jobs raced): record the row under a stable `external_ref`
 * — `crm.send_outbound_message` returns the same row for the same ref — and
 * let only the job that CREATED it, or one that finds it long stale, deliver
 * it. Consent, the 24-hour window, the template fallback, the outbound kill
 * switch and the provider all decide inside `send_outbound_message` and
 * `deliverQueuedText`; nothing here weakens any of them.
 *
 * The caller decides WHAT is said (a template written in code, never a model's
 * words) and WHERE; this decides only whether it has already gone.
 */
export type SystemTextResult =
  | { kind: 'sent'; messageId: string }
  | { kind: 'already_sent' }
  | { kind: 'in_flight' }
  | { kind: 'no_consent' }
  | { kind: 'paused' }
  | { kind: 'failed'; permanent: boolean; detail: string };

/** A row that has sat `pending` this long belongs to a job that died. */
const STALE_MS = 120_000;

export async function sendSystemText(
  admin: Db,
  args: { organizationId: string; conversationId: string; body: string; ref: string },
): Promise<SystemTextResult> {
  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: args.conversationId,
    p_body: args.body,
    p_external_ref: args.ref,
  });
  if (error) return { kind: 'failed', permanent: false, detail: `could not record the message: ${error.message}` };

  const queued = (Array.isArray(data) ? data[0] : data) as
    | (QueuedOutbound & { outcome: string; delivery: string | null })
    | undefined;
  if (!queued) return { kind: 'failed', permanent: false, detail: 'send_outbound_message answered nothing' };
  if (queued.outcome === OUTBOUND_PAUSED) return { kind: 'paused' };
  if (queued.outcome === 'no_consent') return { kind: 'no_consent' };
  if (queued.outcome === 'not_found') return { kind: 'failed', permanent: true, detail: 'the thread no longer exists' };
  if (!queued.message_id) return { kind: 'failed', permanent: false, detail: `message not recorded (${queued.outcome})` };

  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') return { kind: 'already_sent' };
  if (queued.outcome === 'already_sent' && queued.delivery === 'pending') {
    const { data: row } = await admin
      .schema('crm')
      .from('conversation_messages')
      .select('created_at')
      .eq('id', queued.message_id)
      .eq('organization_id', args.organizationId)
      .maybeSingle();
    const ageMs = row?.created_at ? Date.now() - new Date(row.created_at).getTime() : Number.POSITIVE_INFINITY;
    if (ageMs < STALE_MS) return { kind: 'in_flight' };
  }

  const delivered = await deliverQueuedText(admin, {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    body: args.body,
    queued,
  });
  if (!delivered.ok) return { kind: 'failed', permanent: false, detail: `not delivered: ${delivered.error.message}` };
  return { kind: 'sent', messageId: queued.message_id };
}
