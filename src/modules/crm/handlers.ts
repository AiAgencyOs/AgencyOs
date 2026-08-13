import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { approvalRequestedEventSchema, announcementFor } from './schema';

/**
 * Job handlers for the crm module — G-110.
 *
 * The same principal boundary `projects/handlers.ts` states: service.ts is
 * session-bound and lets RLS scope every read; a handler runs behind the
 * cron-authenticated runner on the service-role client, which bypasses RLS
 * entirely. So **every query below scopes by organization_id by hand**, and
 * the organization comes from the job row rather than from the event payload,
 * which is the untrusted part.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type HandlerResult =
  | {
      status: 'succeeded';
      /** 'announced' | 'already_announced' | 'no_group'. */
      outcome: string;
      detail: string;
    }
  | {
      status: 'failed';
      /** True when retrying cannot possibly help — the runner parks the job. */
      permanent: boolean;
      detail: string;
    };

type JobEnvelope = {
  eventId?: number;
  eventType?: string;
  subjectType?: string | null;
  subjectId?: string | null;
  event?: unknown;
};

export type AnnounceJob = {
  id: string;
  organization_id: string;
  payload: JobEnvelope | null;
  correlation_id: string | null;
};

/**
 * `approval.requested` → say so in the internal group.
 *
 * ADM-11 and docs/business-os/02-business-rules.md §5.1: the internal group is
 * where the agent brings what needs deciding. Until this existed the group was
 * a channel with nothing flowing through it and the queue lived only on a web
 * page, which is no use to an owner who is not looking at one.
 *
 * Idempotency has the same three layers the unlock handler documents, and the
 * third is again the one that matters because it holds even if the first two
 * are bypassed: `send_outbound_message` takes the caller's idempotency key,
 * and the key here is derived from the **request id** rather than from the job
 * or the event. So a re-dispatched event, a retried job and a second event for
 * the same request all collapse onto one message — which matters more here
 * than almost anywhere, because the failure mode is an owner's phone buzzing
 * repeatedly about one decision.
 *
 * An organization with no internal group is `succeeded`, not `failed`. Not
 * having set one up is an ordinary state, not an error, and retrying would
 * never fix it — the alternative is a queue slowly filling with jobs that can
 * only ever be parked.
 */
export async function handleApprovalRequested(
  admin: Admin,
  job: AnnounceJob,
): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const requestId = envelope.subjectId ?? null;

  const parsed = approvalRequestedEventSchema.safeParse(envelope.event);
  if (!parsed.success) {
    return {
      status: 'failed',
      permanent: true,
      detail: `malformed approval.requested payload: ${parsed.error.issues[0]?.message ?? 'unparseable'}`,
    };
  }
  if (!requestId) {
    return { status: 'failed', permanent: true, detail: 'approval.requested names no request' };
  }
  const event = parsed.data;

  // ── the group, scoped to the job's organization ─────────────────────────
  const { data: group, error: groupError } = await admin
    .schema('crm')
    .from('conversations')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('kind', 'internal_group')
    .neq('status', 'abandoned')
    .maybeSingle();

  if (groupError) {
    // A read that failed is not a group that is absent. Retryable, because
    // this is exactly the blip the retry budget exists for (D3, D5, D6).
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the internal group: ${groupError.message}`,
    };
  }

  if (!group) {
    return {
      status: 'succeeded',
      outcome: 'no_group',
      detail: 'this organization has no internal group; nothing was announced',
    };
  }

  // ── the message ─────────────────────────────────────────────────────────
  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: group.id,
    p_body: announcementFor(event),
    // Keyed on the request, deliberately — see the header.
    p_external_ref: `approval:${requestId}`,
  });

  if (error) {
    return { status: 'failed', permanent: false, detail: `could not record: ${error.message}` };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found';
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
      }
    | undefined;

  if (!queued) {
    return { status: 'failed', permanent: false, detail: 'send_outbound_message answered nothing' };
  }

  if (queued.outcome === 'not_found') {
    // The group was read a moment ago and is gone now. Permanent: a retry
    // reads the same absence.
    return { status: 'failed', permanent: true, detail: 'the internal group no longer exists' };
  }

  if (queued.outcome === 'already_sent') {
    return {
      status: 'succeeded',
      outcome: 'already_announced',
      detail: `${event.reference} was already announced`,
    };
  }

  if (!queued.to_phone) {
    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'the internal group has no number to send to',
    });
    // Permanent: no amount of retrying gives the group a phone number.
    return {
      status: 'failed',
      permanent: true,
      detail: 'the internal group has no number to send to',
    };
  }

  const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

  const sent = await sendWhatsAppText({
    phoneNumberId: queued.from_phone_number_id ?? '',
    to: queued.to_phone,
    body: announcementFor(event),
  });

  await admin.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.data.providerRef } : { p_error: sent.error.message }),
  });

  if (!sent.ok) {
    // The row survives carrying the reason, so the operations screen and the
    // transcript both show an attempt that failed rather than nothing at all.
    // Retryable: a provider error says nothing about whether the message is
    // sendable, only that this attempt did not land.
    return { status: 'failed', permanent: false, detail: `provider: ${sent.error.message}` };
  }

  return {
    status: 'succeeded',
    outcome: 'announced',
    detail: `${event.reference} announced in the internal group`,
  };
}
