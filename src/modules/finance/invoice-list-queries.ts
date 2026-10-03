import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Readers the invoice list and the invoice page gained in bucket F
 * (SCR-051/052): the milestone each invoice bills (for the column and the
 * milestone filter), the client's billing address for the email form, and
 * the send history per invoice for the reminder drawer. Each is a plain
 * read under RLS; a failed read refuses.
 */

export type InvoiceMilestone = { id: string; name: string; position: number; projectId: string };

/** Every milestone any invoice names, keyed by milestone id. */
export async function readInvoiceMilestones(milestoneIds: readonly string[]): Promise<Map<string, InvoiceMilestone>> {
  const ids = [...new Set(milestoneIds)];
  const out = new Map<string, InvoiceMilestone>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('milestones').select('id, name, position, project_id').in('id', ids);
  if (error) unreadable('readInvoiceMilestones', error);
  for (const m of data ?? []) out.set(m.id, { id: m.id, name: m.name, position: m.position, projectId: m.project_id });
  return out;
}

/** The client account's billing email, or null when none is recorded. */
export async function readClientBillingEmail(clientAccountId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('client_accounts').select('billing_email').eq('id', clientAccountId).maybeSingle();
  if (error) unreadable('readClientBillingEmail', error);
  return data?.billing_email ?? null;
}

export type InvoiceSendHistoryRow = {
  id: string;
  invoiceId: string;
  kind: string;
  channel: string;
  sentAt: string;
  note: string | null;
  messageRef: string | null;
};

/** Every send and reminder across every invoice, newest first, for the list's history drawer. */
export async function readInvoiceSendHistory(limit = 2000): Promise<Map<string, InvoiceSendHistoryRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .from('invoice_sends')
    .select('id, invoice_id, kind, channel, sent_at, note, message_ref')
    .order('sent_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('readInvoiceSendHistory', error);
  const out = new Map<string, InvoiceSendHistoryRow[]>();
  for (const s of data ?? []) {
    const list = out.get(s.invoice_id) ?? [];
    list.push({ id: s.id, invoiceId: s.invoice_id, kind: s.kind, channel: s.channel, sentAt: s.sent_at, note: s.note, messageRef: s.message_ref });
    out.set(s.invoice_id, list);
  }
  return out;
}
