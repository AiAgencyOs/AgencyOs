import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { sendClientDocument, sendClientMessage } from '@/modules/crm/service';

import { invoicePdfForInvoice } from './pdf-service';
import { listPaymentAccounts } from './queries';
import { verifiedOn } from './verified-basis';
import { PAYMENT_ACCOUNT_FIELDS, type PaymentAccountKind } from './schema';
import { invoiceMessage, sendInvoiceWhatsAppSchema, type SendInvoiceWhatsAppInput } from './whatsapp-send-schema';

type RecordRow = { outcome: string; send_id: string | null };

export type SendInvoiceWhatsAppOutcome = {
  sendId: string;
  messageId: string;
  /** False when the text went and the PDF did not; the reason says why. */
  pdfDelivered: boolean;
  pdfReason: string | null;
};

/**
 * Send an issued invoice to the client on WhatsApp — SCR-051, owner decision
 * 2026-09-29 (reverses "records only; nothing here sends").
 *
 * `invoice.issue` (owner, ops_admin): the pair that sends bills. Two legs
 * through the quotation's own doors, in the quotation's own order:
 *
 *   1. the text (`sendClientMessage`) — consent, the 24-hour window, the
 *      outreach limits and the provider all decide there, and a refusal
 *      comes back verbatim with nothing recorded here;
 *   2. the PDF (`sendClientDocument`) — rendered by the same service the
 *      "Open PDF" button uses. A provider failure on this leg is data, not a
 *      refusal: the text already reached the phone, so the send IS recorded,
 *      with the PDF's failure in its note, and the answer says so.
 *
 * Then `finance.record_invoice_send` writes the row and the audit in one
 * transaction, naming the thread and the message. The thread must belong to
 * the invoice: its client account's own thread, its project's group, or a
 * lead thread whose contact or deal is that client. Anything else is
 * refused before a word is composed.
 */
export async function sendInvoiceWhatsApp(
  input: SendInvoiceWhatsAppInput,
): Promise<Result<SendInvoiceWhatsAppOutcome>> {
  const parsed = sendInvoiceWhatsAppSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid send.');
  }

  const context = await requireInternal();
  if (!can(context, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to send invoices.');
  }

  const supabase = await createClient();

  const { data: invoice, error: invoiceError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status, currency, total_minor, paid_minor, verified_minor, due_at, client_account_id, project_id')
    .eq('id', parsed.data.invoiceId)
    .maybeSingle();
  if (invoiceError) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendInvoiceWhatsApp', detail: invoiceError.message }));
    return err('INTERNAL', 'The invoice could not be read.');
  }
  if (!invoice) return err('NOT_FOUND', 'Invoice not found.');
  if (invoice.status === 'draft' || invoice.status === 'pending_approval') {
    return err('CONFLICT', 'This invoice is still a draft. Issue it first — a bill nobody has issued cannot be sent.');
  }
  if (invoice.status === 'void') return err('CONFLICT', 'This invoice was voided. Nothing to send.');

  // ── the thread belongs to this bill ─────────────────────────────────────
  const { data: thread, error: threadError } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, kind, status, client_account_id, project_id, lead_id')
    .eq('id', parsed.data.conversationId)
    .maybeSingle();
  if (threadError) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendInvoiceWhatsApp', detail: threadError.message }));
    return err('INTERNAL', 'The conversation could not be read.');
  }
  if (!thread) return err('NOT_FOUND', 'That conversation is not visible to you.');
  if (thread.status === 'abandoned') return err('CONFLICT', 'That thread was abandoned. Pick a live one.');

  const belongs = await threadBelongsToClient(supabase, thread, invoice.client_account_id, invoice.project_id);
  if (belongs === 'unreadable') return err('INTERNAL', 'The thread could not be checked against the invoice.');
  if (!belongs) {
    return err('VALIDATION', 'That thread is not one of this client’s. An invoice goes only to the client it bills.');
  }

  // ── the words ───────────────────────────────────────────────────────────
  const [{ data: org, error: orgError }, accounts, project] = await Promise.all([
    supabase.schema('core').from('organizations').select('name, timezone').limit(1).maybeSingle(),
    listPaymentAccounts(),
    invoice.project_id
      ? supabase.schema('projects').from('projects').select('name').eq('id', invoice.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (orgError || !org) return err('INTERNAL', 'The organization could not be read, so the message has no sender name.');

  const body = invoiceMessage({
    agencyName: org.name,
    invoiceNumber: invoice.number,
    currency: invoice.currency,
    totalMinor: invoice.total_minor,
    // Owner decision 8 (2026-10-01): verified payments only.
    paidMinor: verifiedOn(invoice),
    dueAt: invoice.due_at,
    timeZone: org.timezone ?? 'UTC',
    projectName: project.data?.name ?? null,
    receivingAccounts: accounts
      .filter((a) => a.status === 'active')
      .map((a) => ({
        label: a.label,
        fields: PAYMENT_ACCOUNT_FIELDS[a.kind as PaymentAccountKind]
          .filter((f) => a.instructions[f.key])
          .map((f) => ({ label: f.label, value: a.instructions[f.key]! })),
      })),
  });

  // ── leg 1: the text, through the governed door ──────────────────────────
  const attempt = crypto.randomUUID();
  const text = await sendClientMessage({
    conversationId: thread.id,
    body,
    idempotencyKey: `invoice:${invoice.id}:${attempt}:text`,
  });
  if (!text.ok) return text;

  // ── leg 2: the PDF ──────────────────────────────────────────────────────
  let pdfDelivered = false;
  let pdfReason: string | null = null;
  const rendered = await invoicePdfForInvoice(invoice.id);
  if (!rendered.ok) {
    pdfReason = rendered.error.message;
  } else {
    const document = await sendClientDocument({
      conversationId: thread.id,
      filename: rendered.data.filename,
      idempotencyKey: `invoice:${invoice.id}:${attempt}:pdf`,
      bytes: rendered.data.bytes,
    });
    if (!document.ok) {
      pdfReason = document.error.message;
    } else if (!document.data.delivered) {
      pdfReason = document.data.reason ?? 'the provider refused the document';
    } else {
      pdfDelivered = true;
    }
  }

  // ── the record, in the same shape the hand-recorded send has ────────────
  const note = [parsed.data.note, pdfDelivered ? null : `PDF not delivered: ${pdfReason}`]
    .filter((n): n is string => Boolean(n))
    .join(' · ')
    .slice(0, 600);

  const { data, error } = await supabase.schema('finance').rpc('record_invoice_send', {
    p_invoice_id: invoice.id,
    p_kind: 'sent',
    p_channel: 'whatsapp',
    p_message_ref: text.data.messageId,
    p_conversation_id: thread.id,
    ...(note ? { p_note: note } : {}),
  });
  if (error) {
    // The message reached the phone and the record did not. Said plainly: the
    // person should not press Send again believing nothing went.
    console.error(JSON.stringify({ level: 'error', scope: 'sendInvoiceWhatsApp', detail: error.message }));
    return err('INTERNAL', 'The invoice was sent, but the send could not be recorded. Record it by hand below rather than sending again.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as RecordRow | undefined;
  if (!row || row.outcome !== 'recorded' || !row.send_id) {
    return err('INTERNAL', `The invoice was sent, but the send could not be recorded (${row?.outcome ?? 'no answer'}). Record it by hand below rather than sending again.`);
  }

  return ok({ sendId: row.send_id, messageId: text.data.messageId, pdfDelivered, pdfReason });
}

type Thread = { id: string; kind: string; client_account_id: string | null; project_id: string | null; lead_id: string | null };

async function threadBelongsToClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  thread: Thread,
  clientAccountId: string,
  projectId: string | null,
): Promise<boolean | 'unreadable'> {
  if (thread.kind === 'client_account') return thread.client_account_id === clientAccountId;
  if (thread.kind === 'project_group') return projectId !== null && thread.project_id === projectId;
  if (thread.kind !== 'direct' || !thread.lead_id) return false;

  // A lead thread: the lead's contact is this client, or a deal on the lead is.
  const [{ data: lead, error: leadError }, { data: deals, error: dealError }] = await Promise.all([
    supabase.schema('crm').from('leads').select('contact_id').eq('id', thread.lead_id).maybeSingle(),
    supabase.schema('sales').from('opportunities').select('client_account_id').eq('lead_id', thread.lead_id),
  ]);
  if (leadError || dealError) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendInvoiceWhatsApp.thread', detail: leadError?.message ?? dealError?.message }));
    return 'unreadable';
  }
  if ((deals ?? []).some((d) => d.client_account_id === clientAccountId)) return true;
  if (!lead?.contact_id) return false;

  const { data: contact, error: contactError } = await supabase
    .schema('crm')
    .from('contacts')
    .select('client_account_id')
    .eq('id', lead.contact_id)
    .maybeSingle();
  if (contactError) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendInvoiceWhatsApp.contact', detail: contactError.message }));
    return 'unreadable';
  }
  return contact?.client_account_id === clientAccountId;
}
