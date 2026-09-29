import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { REMINDER_INTERVAL_DEFAULT_DAYS } from './reminder-schema';

/**
 * Reads for automatic past-due reminders — owner decision 2026-09-29. Every
 * read refuses on failure (G-054).
 */

export type InvoiceReminderPolicy = { enabled: boolean; intervalDays: number };

/** The organization's reminder policy, from its two real columns. */
export async function readInvoiceReminderPolicy(): Promise<InvoiceReminderPolicy> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('organizations')
    .select('invoice_reminders_enabled, invoice_reminder_interval_days')
    .limit(1)
    .maybeSingle();
  if (error) unreadable('readInvoiceReminderPolicy', error);
  return {
    enabled: data?.invoice_reminders_enabled === true,
    intervalDays: data?.invoice_reminder_interval_days ?? REMINDER_INTERVAL_DEFAULT_DAYS,
  };
}

export type InvoiceReminderRow = {
  id: string;
  sentAt: string;
  automatic: boolean;
  channel: string;
  sentByName: string | null;
  conversationId: string | null;
  note: string | null;
  messageRef: string | null;
  /** The outbound message's own state, when AgencyOS sent it; null for a hand-recorded reminder. */
  delivery: 'pending' | 'sent' | 'failed' | null;
  deliveryError: string | null;
};

/**
 * Every reminder on one invoice, newest first, each with the delivery state
 * of the message it became. An automatic reminder whose message row is
 * absent (consent refused, no thread) shows its note instead of a silence.
 */
export async function listInvoiceReminders(invoiceId: string): Promise<InvoiceReminderRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoice_sends')
    .select('id, sent_at, automatic, channel, sent_by, conversation_id, note, message_ref')
    .eq('invoice_id', invoiceId)
    .eq('kind', 'reminder')
    .order('sent_at', { ascending: false });
  if (error) unreadable('listInvoiceReminders', error);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const refs = rows.map((r) => r.message_ref).filter((r): r is string => r !== null && r.startsWith('invoice-reminder:'));
  const deliveryByRef = new Map<string, { delivery: InvoiceReminderRow['delivery']; error: string | null }>();
  if (refs.length > 0) {
    const { data: messages, error: messagesError } = await supabase
      .schema('crm')
      .from('conversation_messages')
      .select('external_ref, metadata')
      .in('external_ref', refs);
    if (messagesError) unreadable('listInvoiceReminders.messages', messagesError);
    for (const m of messages ?? []) {
      if (!m.external_ref) continue;
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      const raw = meta.delivery;
      const delivery = raw === 'pending' || raw === 'sent' || raw === 'failed' ? raw : null;
      const errText = typeof meta.delivery_error === 'string' ? meta.delivery_error : typeof meta.error === 'string' ? meta.error : null;
      deliveryByRef.set(m.external_ref, { delivery, error: errText });
    }
  }

  const userIds = [...new Set(rows.map((r) => r.sent_by).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds);
    if (usersError) unreadable('listInvoiceReminders.users', usersError);
    for (const u of users ?? []) nameById.set(u.id, u.full_name ?? u.email ?? u.id);
  }

  return rows.map((r) => {
    const state = r.message_ref ? deliveryByRef.get(r.message_ref) : undefined;
    return {
      id: r.id,
      sentAt: r.sent_at,
      automatic: r.automatic,
      channel: r.channel,
      sentByName: r.sent_by ? (nameById.get(r.sent_by) ?? null) : r.automatic ? 'AgencyOS (automatic)' : null,
      conversationId: r.conversation_id,
      note: r.note,
      messageRef: r.message_ref,
      delivery: state?.delivery ?? null,
      deliveryError: state?.error ?? null,
    };
  });
}
