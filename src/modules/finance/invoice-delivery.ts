import 'server-only';

import { accountsOnInvoice, readSnapshotAccountIds } from './p4q-snapshot-accounts';
import type { createAdminClient } from '@/lib/db/admin';
import { emailTransportState, sendEmail } from '@/lib/email/transport';
import { OUTBOUND_PAUSED } from '@/modules/crm/kill-switch';

import { renderInvoiceDocument } from './pdf-service';
import { listPaymentAccounts } from './queries';
import { PAYMENT_ACCOUNT_FIELDS, type PaymentAccountKind } from './schema';
import { verifiedOn } from './verified-basis';
import { freeMaintenanceMessage, invoiceMessage } from './whatsapp-send-schema';
import { deliveryStatusOf } from '@/lib/whatsapp/delivery-status';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The automatic delivery of an issued invoice — Phase 2 Finance §4.5, Master
 * §5.7: the bill reaches the client's email AND the official project WhatsApp
 * group, with no one pressing Send, idempotently, and with a channel that
 * failed visible rather than silent.
 *
 * Triggered by `invoice.issued`, so the HUMAN decision stays where it was: a
 * person issues the invoice (the approval gate lives there), and this carries
 * out the consequence. It never issues, never verifies a payment and never
 * decides an amount.
 *
 * ── one row per invoice and channel ──────────────────────────────────────
 *
 * `finance.claim_invoice_delivery` takes the invoice lock and refuses a
 * channel that is already `sent`, which is the whole of the idempotency: a
 * replayed event, a retried job and two overlapping ticks all find the row
 * and stop. A `failed` or `skipped` channel is claimable again — that IS the
 * retry. The WhatsApp legs queue under stable external refs, so even a crash
 * between the provider accepting a message and the row saying so cannot send
 * the text twice.
 */
export type ChannelOutcome = {
  channel: 'whatsapp' | 'email';
  result: 'sent' | 'already_delivered' | 'skipped' | 'failed' | 'paused' | 'not_deliverable';
  detail: string;
};

export type DeliveryOutcome = { outcomes: ChannelOutcome[]; retry: boolean };

type Claim = { outcome: string; delivery_id: string | null; attempts: number };

async function claim(admin: Admin, invoiceId: string, channel: 'whatsapp' | 'email'): Promise<Claim | null> {
  const { data, error } = await admin.schema('finance').rpc('claim_invoice_delivery', { p_invoice_id: invoiceId, p_channel: channel });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'deliverIssuedInvoice.claim', invoice: invoiceId, channel, detail: error.message }));
    return null;
  }
  return ((Array.isArray(data) ? data[0] : data) ?? null) as Claim | null;
}

async function settle(
  admin: Admin,
  deliveryId: string,
  status: 'sent' | 'failed' | 'skipped',
  fields: { destination?: string; conversationId?: string; messageRef?: string; error?: string } = {},
): Promise<void> {
  const { error } = await admin.schema('finance').rpc('settle_invoice_delivery', {
    p_delivery_id: deliveryId,
    p_status: status,
    ...(fields.destination ? { p_destination: fields.destination } : {}),
    ...(fields.conversationId ? { p_conversation_id: fields.conversationId } : {}),
    ...(fields.messageRef ? { p_message_ref: fields.messageRef } : {}),
    ...(fields.error ? { p_error: fields.error } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'deliverIssuedInvoice.settle', delivery: deliveryId, detail: error.message }));
  }
}

export async function deliverIssuedInvoice(
  admin: Admin,
  args: { organizationId: string; invoiceId: string },
): Promise<DeliveryOutcome | { error: string; permanent: boolean }> {
  const { data: invoice, error } = await admin
    .schema('finance')
    .from('invoices')
    .select('id, organization_id, number, status, currency, total_minor, verified_minor, due_at, client_account_id, project_id, maintenance_plan_id')
    .eq('id', args.invoiceId)
    .eq('organization_id', args.organizationId)
    .maybeSingle();
  if (error) return { error: `could not read the invoice: ${error.message}`, permanent: false };
  if (!invoice) return { error: 'the invoice no longer exists', permanent: true };

  const whatsapp = await deliverOnWhatsApp(admin, invoice);
  const email = await deliverByEmail(admin, invoice);
  const outcomes = [whatsapp, email];

  return {
    outcomes,
    retry: outcomes.some((o) => o.result === 'failed' || o.result === 'paused'),
  };
}

export type InvoiceRow = {
  id: string;
  organization_id: string;
  number: string;
  status: string;
  currency: string;
  total_minor: number;
  verified_minor: number;
  due_at: string | null;
  client_account_id: string;
  project_id: string | null;
  /** Set on the free-maintenance document (Finance §9): a ₹0 invoice that is delivered, not collected. */
  maintenance_plan_id?: string | null;
};

// ── WhatsApp ─────────────────────────────────────────────────────────────────

/**
 * The official project group first (Master §5.7), then the client's own thread,
 * then - only when the client has neither yet - the thread the deal was won on.
 */
async function pickThread(admin: Admin, invoice: InvoiceRow): Promise<string | null> {
  if (invoice.project_id) {
    const { data } = await admin
      .schema('crm')
      .from('conversations')
      .select('id, status, updated_at')
      .eq('organization_id', invoice.organization_id)
      .eq('kind', 'project_group')
      .eq('project_id', invoice.project_id)
      .neq('status', 'abandoned')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (data?.[0]) return data[0].id;
  }
  const { data } = await admin
    .schema('crm')
    .from('conversations')
    .select('id, status, updated_at')
    .eq('organization_id', invoice.organization_id)
    .eq('kind', 'client_account')
    .eq('client_account_id', invoice.client_account_id)
    .neq('status', 'abandoned')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (data?.[0]) return data[0].id;

  // Before the project has a group and the client an account thread of their
  // own, the only place the client IS reachable is the thread the deal was won
  // on - the same one the project manager welcomed them on. The advance invoice
  // typically goes out exactly then, so a bill with nowhere to go would wait for
  // a group it does not need. Used ONLY for the delivery of this invoice; a
  // reminder never chases a bill on a sales thread (reminder-schema.ts).
  if (invoice.project_id) {
    const { data: project } = await admin
      .schema('projects')
      .from('projects')
      .select('opportunity_id')
      .eq('id', invoice.project_id)
      .eq('organization_id', invoice.organization_id)
      .maybeSingle();
    if (project?.opportunity_id) {
      const { data: opportunity } = await admin
        .schema('sales')
        .from('opportunities')
        .select('lead_id')
        .eq('id', project.opportunity_id)
        .eq('organization_id', invoice.organization_id)
        .maybeSingle();
      if (opportunity?.lead_id) {
        const { data: direct } = await admin
          .schema('crm')
          .from('conversations')
          .select('id')
          .eq('organization_id', invoice.organization_id)
          .eq('kind', 'direct')
          .eq('lead_id', opportunity.lead_id)
          .neq('status', 'abandoned')
          .order('updated_at', { ascending: false })
          .limit(1);
        return direct?.[0]?.id ?? null;
      }
    }
  }
  return null;
}

async function deliverOnWhatsApp(admin: Admin, invoice: InvoiceRow): Promise<ChannelOutcome> {
  const claimed = await claim(admin, invoice.id, 'whatsapp');
  if (!claimed) return { channel: 'whatsapp', result: 'failed', detail: 'the delivery could not be claimed' };
  if (claimed.outcome === 'already_delivered') return { channel: 'whatsapp', result: 'already_delivered', detail: 'already on WhatsApp' };
  if (claimed.outcome !== 'claimed' || !claimed.delivery_id) {
    return { channel: 'whatsapp', result: 'not_deliverable', detail: claimed.outcome };
  }
  const deliveryId = claimed.delivery_id;

  const fail = async (detail: string): Promise<ChannelOutcome> => {
    await settle(admin, deliveryId, 'failed', { error: detail });
    return { channel: 'whatsapp', result: 'failed', detail };
  };

  const conversationId = await pickThread(admin, invoice);
  if (!conversationId) {
    const detail = 'No WhatsApp thread for this client and the project has no group — nothing to send to.';
    await settle(admin, deliveryId, 'skipped', { error: detail });
    return { channel: 'whatsapp', result: 'skipped', detail };
  }

  const [{ data: org }, project, accounts] = await Promise.all([
    admin.schema('core').from('organizations').select('name, timezone').eq('id', invoice.organization_id).maybeSingle(),
    invoice.project_id
      ? admin.schema('projects').from('projects').select('name').eq('id', invoice.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
    listPaymentAccounts(admin as never),
  ]);
  if (!org) return fail('the organization could not be read, so the message has no sender name');

  const freeUntil = invoice.maintenance_plan_id ? await freeMaintenanceEnd(admin, invoice) : null;
  const body = invoice.maintenance_plan_id
    ? freeMaintenanceMessage({ agencyName: org.name, invoiceNumber: invoice.number, endsOn: freeUntil, projectName: project.data?.name ?? null })
    : invoiceMessage({
    agencyName: org.name,
    invoiceNumber: invoice.number,
    currency: invoice.currency,
    totalMinor: invoice.total_minor,
    paidMinor: verifiedOn(invoice),
    dueAt: invoice.due_at,
    timeZone: org.timezone ?? 'UTC',
    projectName: project.data?.name ?? null,
    receivingAccounts: accountsOnInvoice(accounts, await readSnapshotAccountIds(admin, invoice.id))
      .map((a) => ({
        label: a.label,
        fields: PAYMENT_ACCOUNT_FIELDS[a.kind as PaymentAccountKind]
          .filter((f) => a.instructions[f.key])
          .map((f) => ({ label: f.label, value: a.instructions[f.key]! })),
      })),
  });

  const rendered = await renderInvoiceDocument(admin as never, invoice.id);
  if (!rendered.ok) return fail(`the invoice document could not be rendered: ${rendered.error.message}`);

  // ── leg 1: the text ───────────────────────────────────────────────────────
  const textRef = `invoice-deliver:${invoice.id}:text`;
  const text = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: conversationId,
    p_body: body,
    p_external_ref: textRef,
  });
  if (text.error) return fail(`could not record the message: ${text.error.message}`);
  const queuedText = (Array.isArray(text.data) ? text.data[0] : text.data) as
    | {
        outcome: string;
        delivery: string | null;
        message_id: string | null;
        seq: number | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
      }
    | undefined;
  if (queuedText?.outcome === OUTBOUND_PAUSED) {
    await settle(admin, deliveryId, 'failed', { error: 'Outbound messaging is paused by the owner.' });
    return { channel: 'whatsapp', result: 'paused', detail: 'outbound messaging is paused' };
  }
  if (queuedText?.outcome === 'no_consent') {
    const detail = 'This contact has no recorded consent to be messaged on WhatsApp.';
    await settle(admin, deliveryId, 'skipped', { error: detail, conversationId });
    return { channel: 'whatsapp', result: 'skipped', detail };
  }
  if (!queuedText || (queuedText.outcome !== 'created' && queuedText.outcome !== 'already_sent')) {
    return fail(`the message was refused (${queuedText?.outcome ?? 'no answer'})`);
  }

  let textRefOnWire = textRef;
  if (!(queuedText.outcome === 'already_sent' && queuedText.delivery === 'sent')) {
    const { deliverQueuedText } = await import('@/modules/crm/deliver-text');
    const delivered = await deliverQueuedText(admin as never, {
      organizationId: invoice.organization_id,
      conversationId,
      body,
      queued: {
        message_id: queuedText.message_id,
        seq: queuedText.seq,
        to_phone: queuedText.to_phone,
        from_phone_number_id: queuedText.from_phone_number_id,
        recipient_type: queuedText.recipient_type,
      },
    });
    if (!delivered.ok) return fail(`the message did not go: ${delivered.error.message}`);
    textRefOnWire = delivered.data.messageId;
  }

  // ── leg 2: the PDF ────────────────────────────────────────────────────────
  const doc = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: conversationId,
    p_body: '',
    p_external_ref: `invoice-deliver:${invoice.id}:pdf`,
    p_media_type: 'document',
    p_media_filename: rendered.data.filename,
  });
  if (doc.error) return fail(`could not record the document: ${doc.error.message}`);
  const queuedDoc = (Array.isArray(doc.data) ? doc.data[0] : doc.data) as
    | {
        outcome: string;
        delivery: string | null;
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
      }
    | undefined;
  if (queuedDoc?.outcome === OUTBOUND_PAUSED) {
    await settle(admin, deliveryId, 'failed', { error: 'Outbound messaging is paused by the owner.' });
    return { channel: 'whatsapp', result: 'paused', detail: 'outbound messaging is paused' };
  }
  if (!queuedDoc || (queuedDoc.outcome !== 'created' && queuedDoc.outcome !== 'already_sent')) {
    return fail(`the document was refused (${queuedDoc?.outcome ?? 'no answer'})`);
  }
  if (!(queuedDoc.outcome === 'already_sent' && queuedDoc.delivery === 'sent')) {
    if (!queuedDoc.to_phone) return fail('the thread has no provider id to send the document to');
    const { uploadWhatsAppMedia, sendWhatsAppDocument } = await import('@/lib/whatsapp/send');
    const uploaded = await uploadWhatsAppMedia({
      phoneNumberId: queuedDoc.from_phone_number_id ?? '',
      bytes: rendered.data.bytes,
      mediaType: 'application/pdf',
      filename: rendered.data.filename,
    });
    const sent = uploaded.ok
      ? await sendWhatsAppDocument({
          phoneNumberId: queuedDoc.from_phone_number_id ?? '',
          to: queuedDoc.to_phone,
          mediaId: uploaded.mediaId,
          filename: rendered.data.filename,
          recipientType: queuedDoc.recipient_type ?? 'individual',
        })
      : uploaded;
    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queuedDoc.message_id!,
      p_status: deliveryStatusOf(sent),
      ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
    });
    if (!sent.ok) return fail(`the document did not go: ${sent.message}`);
  }

  await settle(admin, deliveryId, 'sent', { conversationId, messageRef: textRefOnWire });
  return { channel: 'whatsapp', result: 'sent', detail: 'text and PDF delivered' };
}

async function freeMaintenanceEnd(admin: Admin, invoice: InvoiceRow): Promise<string | null> {
  if (!invoice.maintenance_plan_id) return null;
  const { data } = await admin
    .schema('projects')
    .from('maintenance_plans')
    .select('ends_on')
    .eq('id', invoice.maintenance_plan_id)
    .eq('organization_id', invoice.organization_id)
    .maybeSingle();
  return data?.ends_on ?? null;
}

// ── email ────────────────────────────────────────────────────────────────────

export type EmailDeps = {
  transportState: typeof emailTransportState;
  send: typeof sendEmail;
  render: typeof renderInvoiceDocument;
};

const REAL_EMAIL_DEPS: EmailDeps = { transportState: emailTransportState, send: sendEmail, render: renderInvoiceDocument };

/** Exported so the email leg can be driven with a transport that is not the network. */
export async function deliverByEmail(admin: Admin, invoice: InvoiceRow, deps: EmailDeps = REAL_EMAIL_DEPS): Promise<ChannelOutcome> {
  const claimed = await claim(admin, invoice.id, 'email');
  if (!claimed) return { channel: 'email', result: 'failed', detail: 'the delivery could not be claimed' };
  if (claimed.outcome === 'already_delivered') return { channel: 'email', result: 'already_delivered', detail: 'already emailed' };
  if (claimed.outcome !== 'claimed' || !claimed.delivery_id) {
    return { channel: 'email', result: 'not_deliverable', detail: claimed.outcome };
  }
  const deliveryId = claimed.delivery_id;

  const skip = async (detail: string): Promise<ChannelOutcome> => {
    await settle(admin, deliveryId, 'skipped', { error: detail });
    return { channel: 'email', result: 'skipped', detail };
  };

  const transport = await deps.transportState();
  if (!transport.configured) return skip(`Email is not configured on this deployment. ${transport.reason}`.slice(0, 600));

  const { data: contacts } = await admin
    .schema('crm')
    .from('contacts')
    .select('email, created_at')
    .eq('organization_id', invoice.organization_id)
    .eq('client_account_id', invoice.client_account_id)
    .not('email', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1);
  const to = contacts?.[0]?.email?.trim();
  if (!to) return skip('No email address is on file for this client.');

  const rendered = await deps.render(admin as never, invoice.id);
  if (!rendered.ok) {
    await settle(admin, deliveryId, 'failed', { destination: to, error: `the invoice document could not be rendered: ${rendered.error.message}` });
    return { channel: 'email', result: 'failed', detail: rendered.error.message };
  }

  const { data: org } = await admin.schema('core').from('organizations').select('name').eq('id', invoice.organization_id).maybeSingle();
  const agency = org?.name ?? 'the agency';
  const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: invoice.currency, maximumFractionDigits: 2 }).format(invoice.total_minor / 100);
  const due = invoice.due_at ? invoice.due_at.slice(0, 10) : null;

  const free = Boolean(invoice.maintenance_plan_id);
  const sent = await deps.send({
    to,
    subject: free ? `Your free maintenance document ${invoice.number} from ${agency}` : `Invoice ${invoice.number} from ${agency} (${amount})`,
    text: free
      ? [
          `Please find document ${invoice.number} attached. It records the free maintenance included with your project.`,
          'No payment is needed.',
          `— ${agency}`,
        ].join('\n')
      : [
          `Please find invoice ${invoice.number} for ${amount} attached${due ? `, due ${due}` : ''}.`,
          '',
          'Payment details are on the invoice. Thank you.',
          `— ${agency}`,
        ].join('\n'),
    attachments: [{ filename: rendered.data.filename, contentType: 'application/pdf', bytes: rendered.data.bytes }],
  });
  if (!sent.ok) {
    await settle(admin, deliveryId, 'failed', { destination: to, error: sent.reason });
    return { channel: 'email', result: 'failed', detail: sent.reason };
  }

  await settle(admin, deliveryId, 'sent', { destination: to, ...(sent.messageRef ? { messageRef: sent.messageRef } : {}) });
  return { channel: 'email', result: 'sent', detail: `emailed ${to}` };
}
