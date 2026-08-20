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
  /**
   * The message text. Empty bodies are rejected by the column, so also here.
   *
   * Deliberately unbounded above. It carried `.max(10_000)`, copied from
   * crm/schema.ts appendMessageSchema — but that is a bound on a *form*, where
   * a staff member is typing and a limit is a UX affordance. This is a
   * customer's own words arriving from an HMAC-verified provider, and the
   * column that stores them is `text` with no upper bound at all: the only
   * thing the database refuses is emptiness.
   *
   * Applying the form's limit here meant a longer message was discarded
   * outright — the one outcome ARCHITECTURE.md's inbound rules never sanction,
   * since nothing downstream can recover content the transcript never held.
   * Identifiers below stay bounded, because a `wamid` or a phone number over
   * its length is malformed rather than merely long; prose is not.
   */
  body: z.string().trim(),
  /** `contacts[].profile.name`, when the sender has one set. */
  profileName: z.string().trim().max(200).optional(),
  /** When the provider says it was sent. Defaults to arrival time. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  /**
   * The provider's group id, when this arrived in a group — G-115.
   *
   * Its presence changes which function records the message, and that is the
   * whole point: `crm.ingest_whatsapp_message` creates a contact, a lead and a
   * `direct` conversation unconditionally, so a group message routed through it
   * opens a **sales lead on whoever sent it**.
   */
  groupId: z.string().trim().min(1).max(200).optional(),
  /**
   * The kind of a non-text message. Absent for text.
   *
   * Bounded to the kinds Meta actually delivers rather than left open: this
   * value is written into metadata and rendered in the transcript, and an
   * unrecognised string there would be a provider's vocabulary leaking onto a
   * screen a client's account manager reads.
   */
  mediaType: z
    .enum(['audio', 'image', 'video', 'document', 'sticker', 'location'])
    .optional(),
  })
  /**
   * Body and kind are exclusive, and the rule belongs on the pair rather than
   * on either field.
   *
   * `body` was `.min(1)` because an empty text message is meaningless and the
   * column agrees. That is still true — relaxing it to let media through would
   * have quietly admitted the empty text message the old rule existed to
   * refuse. So the emptiness is permitted by exactly one thing: a named kind.
   */
  .superRefine((value, ctx) => {
    if (!value.mediaType && value.body.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'a text message needs a body',
      });
    }
    if (value.mediaType && value.body.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'a media message carries no body — nothing here read it',
      });
    }
  });

export type InboundWhatsAppMessage = z.infer<typeof inboundWhatsAppMessageSchema>;

/**
 * One delivery-status receipt (C10), as the fields the RPC needs — named for
 * this purpose rather than mirroring Meta's envelope, the same discipline
 * inboundWhatsAppMessageSchema keeps. `status` is constrained to the four the
 * function models, so a value the parser somehow let through cannot reach the
 * database as an unknown.
 */
export const deliveryReceiptSchema = z.object({
  /** `metadata.phone_number_id` — our business number; resolves the org. */
  phoneNumberId: z.string().min(1).max(64),
  /** `statuses[].id` — the wamid we stored as provider_ref when accepted. */
  providerRef: z.string().min(1).max(200),
  /** What the wire did. Only these four; the RPC also refuses anything else. */
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  /** When the provider says it happened. Defaults to arrival time. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;

/** What `crm.ingest_group_message` records — no contact, no lead, no job. */
export type GroupIngestOutcome = {
  status: 'ingested' | 'replayed';
  organizationId: string;
  conversationId: string;
  messageId: string;
  seq: number;
};

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
   * The extraction queued for this message, or null. Null on a replay, when an
   * identical extraction was already queued for this transcript, and when the
   * lead is already converted or disqualified — a settled deal is not moved
   * forward by extracting requirements from it. The message is recorded either
   * way; only the follow-on stops.
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
    // Omitted for text, exactly as the function's own default expects. Sending
    // null explicitly would be the same value by a route the generated Args
    // type does not allow.
    ...(parsed.data.mediaType ? { p_media_type: parsed.data.mediaType } : {}),
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

/**
 * Records one inbound **group** message — G-115.
 *
 * A separate function rather than a branch inside `ingestInboundMessage`,
 * because the two do genuinely different things and share only their tenancy
 * lookup: the 1:1 path creates a contact, a lead, a conversation, a message
 * and an extraction job, and this one records a message. Folding them together
 * would mean a function whose return shape depends on a field, and the caller
 * branching on it anyway.
 *
 * **No contact and no lead.** That is the defect this exists to prevent, not
 * an omission: a group participant is not a sales lead, and
 * `crm.ingest_whatsapp_message` would have made one out of every colleague who
 * said "morning" in the internal approval group.
 *
 * An unknown group is a success carrying `unknown_group`, not an error. A
 * business number can be in groups this system does not track, and a webhook
 * that fails on them is one the provider redelivers forever.
 */
export async function ingestGroupMessage(
  admin: Admin,
  input: InboundWhatsAppMessage & { groupId: string },
): Promise<Result<GroupIngestOutcome | { status: 'unknown_group'; organizationId: string }>> {
  const parsed = inboundWhatsAppMessageSchema.safeParse(input);
  if (!parsed.success || !parsed.data.groupId) {
    return err('VALIDATION', 'Inbound group message could not be validated.');
  }

  const { data, error } = await admin.schema('crm').rpc('ingest_group_message', {
    p_phone_number_id: parsed.data.phoneNumberId,
    p_group_id: parsed.data.groupId,
    p_from: parsed.data.from,
    p_external_ref: parsed.data.externalRef,
    p_body: parsed.data.body,
    p_occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
  });

  if (error) {
    // The message itself is never logged: it is customer content, and it is
    // already durable in crm.conversation_messages when this succeeds.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'ingestGroupMessage',
        externalRef: parsed.data.externalRef,
        detail: error.message,
      }),
    );
    return err('INTERNAL', 'Could not record the inbound group message.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        status: string;
        organization_id: string | null;
        conversation_id: string | null;
        message_id: string | null;
        message_seq: number | null;
      }
    | undefined;

  if (!row) return err('INTERNAL', 'Group ingest returned no result.');

  if (row.status === 'unknown_phone_number_id') {
    return err('NOT_FOUND', 'No organization is registered for this WhatsApp number.');
  }

  if (row.status === 'unknown_group') {
    return ok({ status: 'unknown_group', organizationId: row.organization_id ?? '' });
  }

  if (row.status !== 'ingested' && row.status !== 'replayed') {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'ingestGroupMessage',
        detail: `unrecognised group ingest status "${row.status}"`,
      }),
    );
    return err('INTERNAL', 'Could not record the inbound group message.');
  }

  if (
    !row.organization_id ||
    !row.conversation_id ||
    !row.message_id ||
    row.message_seq === null
  ) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'ingestGroupMessage',
        detail: `incomplete group ingest row for status "${row.status}"`,
      }),
    );
    return err('INTERNAL', 'Could not record the inbound group message.');
  }

  return ok({
    status: row.status,
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    seq: row.message_seq,
  });
}

/**
 * The outcome the database reports for one delivery receipt (C10).
 *
 * `recorded` — the wire status advanced and was stamped. Everything else is a
 * deliberate no-op the caller may count but must not treat as a failure:
 * `unmatched` (no outbound message carries this provider_ref — including a
 * receipt racing ahead of our own accept-recording), `ignored_terminal` /
 * `ignored_not_forward` (the monotonic guard refused a regressing or duplicate
 * receipt), `unknown_phone_number_id` (no org claims the number), and
 * `ignored_unknown_status` (a status this slice does not model).
 */
export type DeliveryReceiptOutcome =
  | 'recorded'
  | 'unmatched'
  | 'ignored_terminal'
  | 'ignored_not_forward'
  | 'unknown_phone_number_id'
  | 'ignored_unknown_status';

/**
 * Records one Meta delivery receipt against the outbound message it names.
 *
 * A receipt is provider telemetry, not a customer's words, and the database
 * function is idempotent and monotonic — so this never fails the delivery: an
 * RPC error is logged and surfaced as `unmatched`-like (the caller counts it
 * and moves on) rather than raised, because asking Meta to redeliver a whole
 * batch to recover one status report would risk the real messages in it.
 *
 * Tenancy, correlation and the monotonic transition all live in
 * `crm.record_delivery_receipt`; this supplies the parsed fields and hands back
 * the outcome, the same division ingestInboundMessage keeps with its function.
 */
export async function recordDeliveryReceipt(
  admin: Admin,
  receipt: DeliveryReceipt,
): Promise<Result<{ outcome: DeliveryReceiptOutcome }>> {
  const parsed = deliveryReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    return err('VALIDATION', 'Delivery receipt could not be validated.');
  }

  const { data, error } = await admin.schema('crm').rpc('record_delivery_receipt', {
    p_phone_number_id: parsed.data.phoneNumberId,
    p_provider_ref: parsed.data.providerRef,
    p_status: parsed.data.status,
    // Omitted rather than null: the argument is optional and the function's own
    // default (arrival time) is what an absent provider timestamp means.
    ...(parsed.data.occurredAt ? { p_occurred_at: parsed.data.occurredAt } : {}),
  });

  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'recordDeliveryReceipt',
        providerRef: parsed.data.providerRef,
        detail: error.message,
      }),
    );
    return err('INTERNAL', 'Could not record the delivery receipt.');
  }

  return ok({ outcome: (typeof data === 'string' ? data : 'unmatched') as DeliveryReceiptOutcome });
}
