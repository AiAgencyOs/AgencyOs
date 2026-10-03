import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { recordInvoiceSendSchema, type RecordInvoiceSendInput } from './sends-schema';

type SendRow = { outcome: string; send_id: string | null };

/**
 * Records that an issued invoice was sent, or chased — SCR-051.
 *
 * `invoice.issue` (owner, ops_admin): the same pair that sends bills and
 * that `invoice_sends_insert` admits. The database door
 * `finance.record_invoice_send` refuses a draft (a bill nobody has issued
 * cannot have been sent) and writes the audit row in the same transaction.
 *
 * Deliberately no delivery. There is no invoice WhatsApp door in this
 * repository — `sendWhatsAppDocument` is only ever called for quotations —
 * and inventing one here would be a button that claims to have sent a bill.
 */
export async function recordInvoiceSend(
  input: RecordInvoiceSendInput,
): Promise<Result<{ sendId: string; kind: 'sent' | 'reminder' }>> {
  const parsed = recordInvoiceSendSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid send record.');
  }

  const context = await requireInternal();
  if (!can(context, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to record invoice sends.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('record_invoice_send', {
    p_invoice_id: parsed.data.invoiceId,
    p_kind: parsed.data.kind,
    p_channel: parsed.data.channel,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
    ...(parsed.data.messageRef ? { p_message_ref: parsed.data.messageRef } : {}),
    ...(parsed.data.sentAt ? { p_sent_at: parsed.data.sentAt } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordInvoiceSend', detail: error.message }));
    return err('INTERNAL', 'Could not record the send.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as SendRow | undefined;
  if (!row) return err('INTERNAL', 'Could not record the send.');

  switch (row.outcome) {
    case 'recorded':
      if (!row.send_id) return err('INTERNAL', 'Could not record the send.');
      return ok({ sendId: row.send_id, kind: parsed.data.kind });
    case 'not_found':
      return err('NOT_FOUND', 'Invoice not found.');
    case 'not_issued':
      return err('CONFLICT', 'This invoice is still a draft. Issue it first — a bill nobody has issued cannot have been sent.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'recordInvoiceSend', detail: `unrecognised outcome "${row.outcome}"` }));
      return err('INTERNAL', 'Could not record the send.');
  }
}
