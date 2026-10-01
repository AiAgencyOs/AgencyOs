import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { emailTransportState, sendEmail } from '@/lib/email/transport';
import { err, ok, type Result } from '@/lib/result';

import { sendInvoiceEmailSchema, type SendInvoiceEmailInput } from './email-send-schema';
import { invoicePdfForInvoice } from './pdf-service';
import { recordInvoiceSend } from './sends-service';

/**
 * Send an issued invoice by email — bucket F, SCR-051.
 *
 * `invoice.issue` (owner, ops_admin), the same pair that sends bills on
 * WhatsApp and records sends by hand. The sequence is: the transport must be
 * configured (else an honest refusal naming the variables); the PDF is
 * rendered by the same service the "Open PDF" link uses (so what is mailed
 * is what is on screen, watermark included — a draft is refused before the
 * mail because a draft has no business leaving); the message goes through
 * `sendEmail`; and only a message the provider ACCEPTED is recorded, through
 * the existing `finance.record_invoice_send` door, channel `email`, with the
 * provider's reference. A refused send records nothing, so the list's "last
 * sent" never claims a delivery that did not happen.
 */
export async function sendInvoiceByEmail(
  input: SendInvoiceEmailInput,
): Promise<Result<{ sendId: string; messageRef: string | null; transport: 'resend' | 'smtp' }>> {
  const parsed = sendInvoiceEmailSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid email send.');

  const context = await requireInternal();
  if (!can(context, 'invoice.issue')) return err('FORBIDDEN', 'You do not have permission to send invoices.');

  const transport = await emailTransportState();
  if (!transport.configured) return err('CONFLICT', `Email is not configured on this deployment. ${transport.reason}`);

  const supabase = await createClient();
  const { data: invoice, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status, total_minor, currency, due_at, client_account_id')
    .eq('id', parsed.data.invoiceId)
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendInvoiceByEmail', detail: error.message }));
    return err('INTERNAL', 'Could not read the invoice.');
  }
  if (!invoice) return err('NOT_FOUND', 'Invoice not found.');
  if (invoice.status === 'draft' || invoice.status === 'pending_approval') {
    return err('CONFLICT', 'This invoice is still a draft. Issue it first — a bill nobody has issued cannot be sent.');
  }
  if (invoice.status === 'void') return err('CONFLICT', 'A voided invoice is not sent.');

  const pdf = await invoicePdfForInvoice(invoice.id);
  if (!pdf.ok) return pdf;

  const { data: org } = await supabase.schema('core').from('organizations').select('name').limit(1).maybeSingle();
  const agency = org?.name ?? 'the agency';
  const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: invoice.currency, maximumFractionDigits: 2 }).format(invoice.total_minor / 100);
  const isReminder = parsed.data.kind === 'reminder';
  const due = invoice.due_at ? invoice.due_at.slice(0, 10) : null;
  const subject = isReminder ? `Reminder: invoice ${invoice.number} from ${agency} (${amount})` : `Invoice ${invoice.number} from ${agency} (${amount})`;
  const text = [
    isReminder
      ? `This is a reminder that invoice ${invoice.number} for ${amount} is outstanding${due ? ` (due ${due})` : ''}.`
      : `Please find invoice ${invoice.number} for ${amount} attached${due ? `, due ${due}` : ''}.`,
    parsed.data.note ? `\n${parsed.data.note}` : '',
    `\nPayment details are on the invoice. Thank you.\n— ${agency}`,
  ].join('\n');

  const sent = await sendEmail({
    to: parsed.data.to,
    subject,
    text,
    attachments: [{ filename: pdf.data.filename, contentType: 'application/pdf', bytes: pdf.data.bytes }],
  });
  if (!sent.ok) return err('INTERNAL', sent.reason);

  const recorded = await recordInvoiceSend({
    invoiceId: invoice.id,
    kind: parsed.data.kind,
    channel: 'email',
    note: `to ${parsed.data.to} via ${sent.kind}${parsed.data.note ? ` — ${parsed.data.note}` : ''}`.slice(0, 600),
    ...(sent.messageRef ? { messageRef: sent.messageRef.slice(0, 200) } : {}),
  });
  if (!recorded.ok) {
    // The mail left. Say so rather than hide it behind the record failure.
    console.error(JSON.stringify({ level: 'error', scope: 'sendInvoiceByEmail', detail: `sent but not recorded: ${recorded.error.message}` }));
    return err('INTERNAL', `The email was sent (${sent.kind}${sent.messageRef ? ` ref ${sent.messageRef}` : ''}) but could not be recorded: ${recorded.error.message}`);
  }
  return ok({ sendId: recorded.data.sendId, messageRef: sent.messageRef, transport: sent.kind });
}
