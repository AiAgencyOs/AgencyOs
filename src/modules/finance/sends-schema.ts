import { z } from 'zod';

/** Same vocabulary as the finance.invoice_sends CHECKs (migration 20260929160000). */
export const INVOICE_SEND_KINDS = ['sent', 'reminder'] as const;
export type InvoiceSendKind = (typeof INVOICE_SEND_KINDS)[number];

export const INVOICE_SEND_CHANNELS = ['whatsapp', 'email', 'manual'] as const;
export type InvoiceSendChannel = (typeof INVOICE_SEND_CHANNELS)[number];

export const INVOICE_SEND_CHANNEL_LABEL: Record<InvoiceSendChannel, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  manual: 'By hand / other',
};

/**
 * Recording that an invoice was sent, or chased — SCR-051. A record, not a
 * send: nothing in this module delivers an invoice to a client, and the form
 * says so.
 */
export const recordInvoiceSendSchema = z.object({
  invoiceId: z.uuid(),
  kind: z.enum(INVOICE_SEND_KINDS),
  channel: z.enum(INVOICE_SEND_CHANNELS),
  note: z.string().trim().max(600).optional(),
  messageRef: z.string().trim().max(200).optional(),
  /** ISO timestamp; absent means "now". */
  sentAt: z.string().trim().optional(),
});

export type RecordInvoiceSendInput = z.infer<typeof recordInvoiceSendSchema>;

/** Days an issued, past-due invoice may go without a reminder before the list flags it. */
export const REMINDER_GRACE_DAYS = 7;

/**
 * Whether the invoices list should flag an invoice as needing a reminder:
 * issued (or past issued), past its due date, and no reminder recorded in the
 * last `REMINDER_GRACE_DAYS`. Pure, so the list and a test agree.
 */
export function needsReminder(
  invoice: { status: string; due_at: string | null },
  lastReminderAt: string | null,
  now: Date,
): boolean {
  if (!['issued', 'partially_paid', 'overdue'].includes(invoice.status)) return false;
  if (!invoice.due_at) return false;
  if (new Date(invoice.due_at).getTime() >= now.getTime()) return false;
  if (!lastReminderAt) return true;
  const since = now.getTime() - new Date(lastReminderAt).getTime();
  return since > REMINDER_GRACE_DAYS * 86_400_000;
}
