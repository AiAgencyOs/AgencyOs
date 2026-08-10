import 'server-only';

import { z } from 'zod';

import type { createAdminClient } from '@/lib/db/admin';
import { err, ok, type Result } from '@/lib/result';

/**
 * Inbound WhatsApp ingest — the application half.
 *
 * The work itself is one statement, `crm.ingest_whatsapp_message`, for the
 * reasons its migration gives: five inserts across two schemas must be atomic,
 * and a transcript position cannot be assigned safely by reading a maximum and
 * then inserting. This module supplies what belongs in the application — the
 * shape of a trusted payload, and an outcome the caller can branch on — and
 * deliberately does not reimplement the rule. Same division as
 * src/lib/jobs/staleness.ts against core.reap_stalled_jobs.
 *
 * Service-role only, and by design: the function resolves its own tenancy from
 * `core.organizations.settings`, so there is no session to scope it by. The
 * caller will be app/api/webhooks/whatsapp, which ARCHITECTURE.md §7.3 already
 * lists as a permitted service-role site. Passing the client in rather than
 * constructing it keeps that decision at the call site, matching
 * modules/projects/handlers.ts and lib/events/dispatch.ts.
 *
 * This path never sends anything. §6.1 forbids an agent committing client
 * communication without recorded human approval, and requirement_collector is
 * L1 — it proposes, a human sends. Ingest records what arrived and queues the
 * extraction; a reply is a later, human-gated step.
 */

type Admin = ReturnType<typeof createAdminClient>;

/**
 * One inbound text message, as a WhatsApp Cloud API webhook describes it.
 *
 * Named for the fields this needs rather than mirroring Meta's envelope: the
 * unwrapping of `entry[].changes[].value` belongs in the route, so that
 * swapping provider — or replaying a fixture — does not reach in here.
 */
export const inboundWhatsAppMessageSchema = z.object({
  /** `metadata.phone_number_id` — the business number that received it. */
  phoneNumberId: z.string().min(1).max(64),
  /** The sender's number. Digits, with or without a leading `+`. */
  from: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,20}$/, 'from must be a phone number in digits'),
  /** The provider's message id (`wamid.…`). The replay guard. */
  externalRef: z.string().min(1).max(200),
  /** The message text. Empty bodies are rejected by the column, so also here. */
  body: z.string().trim().min(1).max(10_000),
  /** `contacts[].profile.name`, when the sender has one set. */
  profileName: z.string().trim().max(200).optional(),
  /** When the provider says it was sent. Defaults to arrival time. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

export type InboundWhatsAppMessage = z.infer<typeof inboundWhatsAppMessageSchema>;

export type IngestOutcome = {
  /** `ingested` — new message. `replayed` — this id was already recorded. */
  status: 'ingested' | 'replayed';
  organizationId: string;
  contactId: string;
  leadId: string;
  conversationId: string;
  messageId: string;
  /** Position in the transcript. 0 for the first message on a thread. */
  seq: number;
  /**
   * The extraction queued for this message, or null. Null on a replay, and
   * also when an identical extraction was already queued for this transcript.
   */
  jobId: string | null;
};

/** The row shape `crm.ingest_whatsapp_message` returns. */
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
 * Records one inbound message and everything it implies, exactly once.
 *
 * Redelivery is free: the provider may deliver the same message any number of
 * times and only the first writes anything. That is the property the caller
 * depends on — a webhook must answer 200 quickly and is retried when it does
 * not, so "already handled" has to be a success, not a conflict.
 *
 * An unrecognised `phoneNumberId` is NOT_FOUND rather than a thrown error: a
 * provider can deliver to a number the business no longer serves, and the
 * webhook still has to acknowledge it rather than retry forever.
 */
export async function ingestInboundMessage(
  admin: Admin,
  input: InboundWhatsAppMessage,
): Promise<Result<IngestOutcome>> {
  const parsed = inboundWhatsAppMessageSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Inbound message could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const { data, error } = await admin.schema('crm').rpc('ingest_whatsapp_message', {
    p_phone_number_id: parsed.data.phoneNumberId,
    p_from: parsed.data.from,
    p_external_ref: parsed.data.externalRef,
    p_body: parsed.data.body,
    p_occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
    // Omitted rather than sent as null: the argument is optional and the
    // function's own default supplies null, which is what an absent profile
    // name means. Sending null explicitly would be the same value by a route
    // the generated Args type does not allow.
    ...(parsed.data.profileName ? { p_profile_name: parsed.data.profileName } : {}),
  });

  if (error) {
    // The message itself is never logged: it is customer content, and it is
    // already durable in crm.conversation_messages when this succeeds.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'ingestInboundMessage',
        externalRef: parsed.data.externalRef,
        detail: error.message,
      }),
    );
    return err('INTERNAL', 'Could not record the inbound message.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as IngestRow | undefined;
  if (!row) return err('INTERNAL', 'Ingest returned no result.');

  if (row.status === 'unknown_phone_number_id') {
    return err('NOT_FOUND', 'No organization is registered for this WhatsApp number.');
  }

  if (row.status !== 'ingested' && row.status !== 'replayed') {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'ingestInboundMessage',
        detail: `unrecognised ingest status "${row.status}"`,
      }),
    );
    return err('INTERNAL', 'Could not record the inbound message.');
  }

  // Every id below is non-null whenever the status is one of the two above;
  // the function returns them together or not at all. Checked rather than
  // asserted, because a null here would mean the SQL and this file disagree.
  if (
    !row.organization_id ||
    !row.contact_id ||
    !row.lead_id ||
    !row.conversation_id ||
    !row.message_id ||
    row.message_seq === null
  ) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'ingestInboundMessage',
        detail: `incomplete ingest row for status "${row.status}"`,
      }),
    );
    return err('INTERNAL', 'Could not record the inbound message.');
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
