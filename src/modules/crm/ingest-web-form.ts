import 'server-only';

import { z } from 'zod';

import type { createAdminClient } from '@/lib/db/admin';
import { err, ok, type Result } from '@/lib/result';

/**
 * Inbound web-form ingest — audit step 1.1's first of three missing doors.
 *
 * Same division `src/modules/crm/ingest.ts` documents for WhatsApp: the work
 * is one SQL statement, `crm.ingest_web_form_lead` (migration
 * 20260929130000), because several inserts across tables must be atomic and a
 * transcript position cannot be assigned safely by reading a maximum and then
 * inserting. This module supplies the trusted-payload shape and turns the
 * function's outcome into a Result the route can branch on.
 *
 * Service-role only, for the same reason WhatsApp's ingest is: a public
 * contact-form POST carries no session, so tenancy is resolved from the
 * payload — `web_form_key`, matched against `core.organizations.settings` —
 * inside the ingest itself.
 */

type Admin = ReturnType<typeof createAdminClient>;

/**
 * A contact-form submission, shaped the way a route hands it over rather than
 * mirroring any particular form builder's field names.
 */
export const inboundWebFormLeadSchema = z
  .object({
    /** Identifies the organization. Not a secret in the HMAC sense — see the route's own anti-abuse checks. */
    formKey: z.string().trim().min(1).max(128),
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{6,20}$/, 'phone must be a phone number in digits')
      .optional(),
    /** The free-text field ("How can we help?"). Optional: some forms only ask for contact details. */
    message: z.string().trim().max(20_000).optional(),
    /** An idempotency key the client supplies to survive a double-submit/retry. Not required — a resubmission without one is a second, distinct message on the same thread. */
    externalRef: z.string().trim().min(1).max(200).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    pageUrl: z.string().trim().min(1).max(2000).optional(),
    utmSource: z.string().trim().min(1).max(200).optional(),
    utmCampaign: z.string().trim().min(1).max(200).optional(),
  })
  // A contact must be reachable, or it is not a contact — crm.contacts'
  // own rule, refused here rather than raised as a column check on a public
  // endpoint that has no session to report the error to sensibly.
  .refine((value) => Boolean(value.email) || Boolean(value.phone), {
    message: 'a submission needs an email or a phone number',
    path: ['email'],
  });

export type InboundWebFormLead = z.infer<typeof inboundWebFormLeadSchema>;

export type WebFormIngestOutcome = {
  status: 'ingested' | 'replayed';
  organizationId: string;
  contactId: string;
  leadId: string;
  conversationId: string;
  /** Null when the submission carried no message field. */
  messageId: string | null;
  seq: number | null;
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
 * Records one web-form submission and everything it implies, exactly once per
 * (organization, identity) thread.
 *
 * An unrecognised `formKey` is NOT_FOUND rather than a thrown error, matching
 * `ingestInboundMessage`: a form can be embedded with a stale key after an
 * organization rotates it, and the caller should answer normally rather than
 * surface an internal error to a site visitor.
 */
export async function ingestWebFormLead(
  admin: Admin,
  input: InboundWebFormLead,
): Promise<Result<WebFormIngestOutcome>> {
  const parsed = inboundWebFormLeadSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Inbound web-form submission could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const { data, error } = await admin.schema('crm').rpc('ingest_web_form_lead', {
    p_form_key: parsed.data.formKey,
    p_full_name: parsed.data.fullName,
    ...(parsed.data.email ? { p_email: parsed.data.email } : {}),
    ...(parsed.data.phone ? { p_phone: parsed.data.phone } : {}),
    ...(parsed.data.message ? { p_message: parsed.data.message } : {}),
    ...(parsed.data.externalRef ? { p_external_ref: parsed.data.externalRef } : {}),
    p_occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
    ...(parsed.data.pageUrl ? { p_page_url: parsed.data.pageUrl } : {}),
    ...(parsed.data.utmSource ? { p_utm_source: parsed.data.utmSource } : {}),
    ...(parsed.data.utmCampaign ? { p_utm_campaign: parsed.data.utmCampaign } : {}),
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestWebFormLead', detail: error.message }),
    );
    return err('INTERNAL', 'Could not record the web-form submission.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as IngestRow | undefined;
  if (!row) return err('INTERNAL', 'Ingest returned no result.');

  if (row.status === 'unknown_form_key') {
    return err('NOT_FOUND', 'No organization is registered for this form.');
  }
  if (row.status === 'not_reachable') {
    return err('VALIDATION', 'A submission needs an email or a phone number.');
  }
  if (row.status !== 'ingested' && row.status !== 'replayed') {
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestWebFormLead', detail: `unrecognised status "${row.status}"` }),
    );
    return err('INTERNAL', 'Could not record the web-form submission.');
  }
  if (!row.organization_id || !row.contact_id || !row.lead_id || !row.conversation_id) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestWebFormLead', detail: `incomplete ingest row for status "${row.status}"` }),
    );
    return err('INTERNAL', 'Could not record the web-form submission.');
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
