import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type InboundEmailRow = { id: string; lane: string; fromEmail: string; subject: string | null; kind: string; outcome: string; receivedAt: string };
export type MailboxState = { lane: string; lastPolledAt: string | null; lastOkAt: string | null; lastError: string | null; lastHandled: number };

/** The most recent emails read from the mailboxes (admin-only by RLS) and how each mailbox is doing. No body is kept or shown. */
export async function readInboundEmail(limit = 15): Promise<{ rows: InboundEmailRow[]; mailboxes: MailboxState[] }> {
  const supabase = await createClient();
  const [rows, state] = await Promise.all([
    supabase.schema('crm').from('inbound_emails').select('id, lane, from_email, subject, kind, outcome, received_at').order('received_at', { ascending: false }).limit(limit),
    supabase.schema('crm').from('inbound_email_state').select('lane, last_polled_at, last_ok_at, last_error, last_handled'),
  ]);
  if (rows.error) unreadable('readInboundEmail.rows', rows.error);
  if (state.error) unreadable('readInboundEmail.state', state.error);
  return {
    rows: (rows.data ?? []).map((r) => ({ id: r.id, lane: r.lane, fromEmail: r.from_email, subject: r.subject, kind: r.kind, outcome: r.outcome, receivedAt: r.received_at })),
    mailboxes: (state.data ?? []).map((s) => ({ lane: s.lane, lastPolledAt: s.last_polled_at, lastOkAt: s.last_ok_at, lastError: s.last_error, lastHandled: s.last_handled })),
  };
}
