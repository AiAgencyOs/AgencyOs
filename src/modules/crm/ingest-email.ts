import 'server-only';

import { z } from 'zod';

import type { createAdminClient } from '@/lib/db/admin';
import { err, ok, type Result } from '@/lib/result';

/**
 * Inbound email ingest — audit step 1.1's second missing door.
 *
 * Same division as `src/modules/crm/ingest.ts` (WhatsApp): the atomic work is
 * one SQL statement, `crm.ingest_email_lead` (migration 20260929130000).
 *
 * The provider shape is an ASSUMPTION, stated rather than hidden: nothing in
 * `src/lib/env.ts` or `.env.example` names an email provider before this
 * change, so this module is written against the fields every inbound-email
 * webhook (Mailgun's Inbound Route, SendGrid's Inbound Parse, Postmark's
 * inbound webhook) carries in common — a mailbox, a sender, a subject, a
 * plain-text body, and a Message-ID — rather than any one vendor's envelope.
 * The route unwraps the vendor's actual shape into this one, the same
 * division `parseDelivery` keeps for WhatsApp.
 */

type Admin = ReturnType<typeof createAdminClient>;

export const inboundEmailMessageSchema = z.object({
  /** The address the message was delivered to — resolves the organization. */
  mailbox: z.string().trim().email().max(320),
  fromEmail: z.string().trim().email().max(320),
  fromName: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(500).optional(),
  /** Plain-text body. Unbounded above for the same reason inboundWhatsAppMessageSchema's body is: a customer's own words, from a verified provider. */
  body: z.string().trim(),
  /** The provider's Message-ID. The replay guard. */
  externalRef: z.string().trim().min(1).max(300),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

export type InboundEmailMessage = z.infer<typeof inboundEmailMessageSchema>;

export type EmailIngestOutcome = {
  status: 'ingested' | 'replayed';
  organizationId: string;
  contactId: string;
  leadId: string;
  conversationId: string;
  messageId: string;
  seq: number;
  jobId: string | null;
};

type IngestRow = {
  status: string;
  organization_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  message_seq: number | null;
  job_id: string | null;
};

/**
 * Records one inbound email and everything it implies, exactly once per
 * provider Message-ID.
 *
 * An unrecognised `mailbox` is NOT_FOUND rather than a thrown error, matching
 * `ingestInboundMessage`: mail can arrive at an address no organization has
 * (yet) configured, and the webhook still has to acknowledge it rather than
 * have the provider retry forever.
 */
export async function ingestEmailLead(
  admin: Admin,
  input: InboundEmailMessage,
): Promise<Result<EmailIngestOutcome>> {
  const parsed = inboundEmailMessageSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Inbound email could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const { data, error } = await admin.schema('crm').rpc('ingest_email_lead', {
    p_mailbox: parsed.data.mailbox,
    p_from_email: parsed.data.fromEmail,
    ...(parsed.data.fromName ? { p_from_name: parsed.data.fromName } : {}),
    ...(parsed.data.subject ? { p_subject: parsed.data.subject } : {}),
    p_body: parsed.data.body,
    p_external_ref: parsed.data.externalRef,
    p_occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
  });

  if (error) {
    // The message body is never logged: it is customer content, and it is
    // already durable in crm.conversation_messages when this succeeds.
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestEmailLead', externalRef: parsed.data.externalRef, detail: error.message }),
    );
    return err('INTERNAL', 'Could not record the inbound email.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as IngestRow | undefined;
  if (!row) return err('INTERNAL', 'Ingest returned no result.');

  if (row.status === 'unknown_mailbox') {
    return err('NOT_FOUND', 'No organization is registered for this mailbox.');
  }
  if (row.status !== 'ingested' && row.status !== 'replayed') {
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestEmailLead', detail: `unrecognised status "${row.status}"` }),
    );
    return err('INTERNAL', 'Could not record the inbound email.');
  }
  if (
    !row.organization_id ||
    !row.contact_id ||
    !row.lead_id ||
    !row.conversation_id ||
    !row.message_id ||
    row.message_seq === null
  ) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestEmailLead', detail: `incomplete ingest row for status "${row.status}"` }),
    );
    return err('INTERNAL', 'Could not record the inbound email.');
  }

  return ok({
    status: row.status,
    organizationId: row.organization_id,
    contactId: row.contact_id,
    leadId: row.lead_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    seq: row.message_seq,
    jobId: row.job_id,
  });
}
