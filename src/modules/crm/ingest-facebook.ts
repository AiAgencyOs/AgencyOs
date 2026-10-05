import 'server-only';

import { z } from 'zod';

import type { createAdminClient } from '@/lib/db/admin';
import { err, ok, type Result } from '@/lib/result';

/**
 * Inbound Facebook/Instagram Lead Ads ingest — audit step 1.1's third missing
 * door.
 *
 * Same division as `src/modules/crm/ingest.ts` (WhatsApp): the atomic work is
 * one SQL statement, `crm.ingest_facebook_lead` (migration 20260929130000).
 *
 * Meta's Lead Ads webhook delivers only `leadgen_id` (plus `page_id`,
 * `form_id`, `ad_id`) — the field answers themselves must be fetched
 * separately from the Graph API (`GET /{leadgen_id}?access_token=…`), done by
 * `src/lib/facebook/graph.ts`, on the same pattern `src/lib/whatsapp/media.ts`
 * fetches a message's media by handle. The route does that fetch and hands
 * this module the already-parsed field data — the unwrapping of Meta's
 * envelope belongs there, the same division `parseDelivery` keeps for
 * WhatsApp.
 */

type Admin = ReturnType<typeof createAdminClient>;

export const inboundFacebookLeadSchema = z.object({
  /** The Facebook Page the ad belongs to — resolves the organization. */
  pageId: z.string().trim().min(1).max(64),
  /** Meta's id for this submission. The replay guard, at the lead level: a Lead Ad has no separate "message" to be idempotent about. */
  leadgenId: z.string().trim().min(1).max(200),
  fullName: z.string().trim().max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,20}$/, 'phone must be a phone number in digits')
    .optional(),
  adId: z.string().trim().min(1).max(120).optional(),
  adName: z.string().trim().min(1).max(300).optional(),
  formId: z.string().trim().min(1).max(120).optional(),
  formName: z.string().trim().min(1).max(300).optional(),
  /** The form's raw question/answer pairs, as the Graph API returned them (already flattened to one string per field by src/lib/facebook/graph.ts). */
  fieldData: z.record(z.string(), z.string()).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

export type InboundFacebookLead = z.infer<typeof inboundFacebookLeadSchema>;

export type FacebookIngestOutcome = {
  status: 'ingested' | 'replayed';
  organizationId: string;
  contactId: string;
  leadId: string;
  activityId: string | null;
};

type IngestRow = {
  status: string;
  organization_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  activity_id: string | null;
};

/**
 * Records one Lead Ad submission and everything it implies, exactly once per
 * `leadgen_id`.
 *
 * An unrecognised `pageId` is NOT_FOUND, matching the other two channels — a
 * Page can run ads before its lead form is connected to an organization.
 */
export async function ingestFacebookLead(
  admin: Admin,
  input: InboundFacebookLead,
): Promise<Result<FacebookIngestOutcome>> {
  const parsed = inboundFacebookLeadSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Inbound Lead Ad submission could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const { data, error } = await admin.schema('crm').rpc('ingest_facebook_lead', {
    p_page_id: parsed.data.pageId,
    p_leadgen_id: parsed.data.leadgenId,
    ...(parsed.data.fullName ? { p_full_name: parsed.data.fullName } : {}),
    ...(parsed.data.email ? { p_email: parsed.data.email } : {}),
    ...(parsed.data.phone ? { p_phone: parsed.data.phone } : {}),
    ...(parsed.data.adId ? { p_ad_id: parsed.data.adId } : {}),
    ...(parsed.data.adName ? { p_ad_name: parsed.data.adName } : {}),
    ...(parsed.data.formId ? { p_form_id: parsed.data.formId } : {}),
    ...(parsed.data.formName ? { p_form_name: parsed.data.formName } : {}),
    ...(parsed.data.fieldData ? { p_field_data: parsed.data.fieldData } : {}),
    p_occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestFacebookLead', leadgenId: parsed.data.leadgenId, detail: error.message }),
    );
    return err('INTERNAL', 'Could not record the Lead Ad submission.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as IngestRow | undefined;
  if (!row) return err('INTERNAL', 'Ingest returned no result.');

  if (row.status === 'unknown_page_id') {
    return err('NOT_FOUND', 'No organization is registered for this Facebook Page.');
  }
  if (row.status === 'not_reachable') {
    return err('VALIDATION', 'A Lead Ad submission needs an email or a phone number.');
  }
  if (row.status !== 'ingested' && row.status !== 'replayed') {
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestFacebookLead', detail: `unrecognised status "${row.status}"` }),
    );
    return err('INTERNAL', 'Could not record the Lead Ad submission.');
  }
  if (!row.organization_id || !row.contact_id || !row.lead_id) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'ingestFacebookLead', detail: `incomplete ingest row for status "${row.status}"` }),
    );
    return err('INTERNAL', 'Could not record the Lead Ad submission.');
  }

  return ok({
    status: row.status,
    organizationId: row.organization_id,
    contactId: row.contact_id,
    leadId: row.lead_id,
    activityId: row.activity_id,
  });
}
