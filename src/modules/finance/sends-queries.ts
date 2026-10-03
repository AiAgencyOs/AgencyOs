import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads over finance.invoice_sends — SCR-051's send / reminder records.
 * Every read refuses on failure (G-054): an invoice with an unreadable send
 * history must not render as one nobody ever sent.
 */

export type InvoiceSendRow = {
  id: string;
  invoiceId: string;
  kind: 'sent' | 'reminder';
  channel: string;
  sentBy: string | null;
  sentByName: string | null;
  sentAt: string;
  note: string | null;
  messageRef: string | null;
};

/** Every send and reminder recorded against one invoice, newest first. */
export async function listInvoiceSends(invoiceId: string): Promise<InvoiceSendRow[]> {
  const supabase = await createClient();

  const { data, error: sendsError } = await supabase
    .schema('finance')
    .from('invoice_sends')
    .select('id, invoice_id, kind, channel, sent_by, sent_at, note, message_ref')
    .eq('invoice_id', invoiceId)
    .order('sent_at', { ascending: false });

  if (sendsError) unreadable('listInvoiceSends', sendsError);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.sent_by).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .schema('core')
      .from('users')
      .select('id, full_name, email')
      .in('id', userIds);
    if (usersError) unreadable('listInvoiceSends.users', usersError);
    for (const u of users ?? []) nameById.set(u.id, u.full_name ?? u.email ?? u.id);
  }

  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoice_id,
    kind: r.kind === 'reminder' ? 'reminder' : 'sent',
    channel: r.channel,
    sentBy: r.sent_by,
    sentByName: r.sent_by ? (nameById.get(r.sent_by) ?? null) : null,
    sentAt: r.sent_at,
    note: r.note,
    messageRef: r.message_ref,
  }));
}

export type InvoiceSendSummary = {
  /** The most recent send or reminder of any kind. */
  lastAt: string | null;
  lastKind: 'sent' | 'reminder' | null;
  /** The most recent reminder specifically. */
  lastReminderAt: string | null;
};

/**
 * The last send per invoice, across the whole list — one read rather than
 * one per row. Invoices with no record are absent from the map.
 */
export async function readInvoiceSendSummaries(limit = 5000): Promise<Map<string, InvoiceSendSummary>> {
  const supabase = await createClient();

  const { data, error: sendsError } = await supabase
    .schema('finance')
    .from('invoice_sends')
    .select('invoice_id, kind, sent_at')
    .order('sent_at', { ascending: false })
    .limit(limit);

  if (sendsError) unreadable('readInvoiceSendSummaries', sendsError);

  const summaries = new Map<string, InvoiceSendSummary>();
  for (const r of data ?? []) {
    const current = summaries.get(r.invoice_id) ?? { lastAt: null, lastKind: null, lastReminderAt: null };
    // Rows arrive newest first, so the first one seen per invoice is the last send.
    if (!current.lastAt) {
      current.lastAt = r.sent_at;
      current.lastKind = r.kind === 'reminder' ? 'reminder' : 'sent';
    }
    if (r.kind === 'reminder' && !current.lastReminderAt) current.lastReminderAt = r.sent_at;
    summaries.set(r.invoice_id, current);
  }
  return summaries;
}
