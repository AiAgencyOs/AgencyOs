import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import {
  approvalRequestedEventSchema,
  announcementFor,
  conversationEscalatedEventSchema,
  escalationAnnouncementFor,
} from './schema';

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

  /**
   * Who asked — and this is what lets the announcement carry an amount at all.
   *
   * `crm.refuse_unread_price` refuses an agency message that states a price
   * when `author_id` is null, and `announcementFor` renders
   * `event.amountMinor` as currency. So the first quotation ever submitted
   * would have raised its approval, queued this announcement, and had the row
   * **refuse it** — retrying until the job died with the owner never told.
   * Nobody had hit it because nobody had submitted a quotation.
   *
   * The fix is not an exemption. The announcement **does** have a human
   * behind it: the person who submitted the quotation, recorded on the request
   * as `requested_by_id`. Naming them satisfies the guard by being true rather
   * than by carving a hole in it — and it is the same person the audit trail
   * already points at.
   *
   * Read from the request row rather than added to the event, because the row
   * is the authority and an event shape is a second copy to keep in step. Null
   * when an agent raised it, which is exactly when a price should be refused.
   */
  const { data: request } = await admin
    .schema('approvals')
    .from('approval_requests')
    .select('requested_by_id')
    .eq('id', requestId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  // ── the message ─────────────────────────────────────────────────────────
  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: group.id,
    p_body: announcementFor(event, Boolean(request?.requested_by_id)),
    // Keyed on the request, deliberately — see the header.
    p_external_ref: `approval:${requestId}`,
    ...(request?.requested_by_id ? { p_author_id: request.requested_by_id } : {}),
  });

  if (error) {
    return { status: 'failed', permanent: false, detail: `could not record: ${error.message}` };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent';
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
        delivery: 'pending' | 'sent' | 'failed' | null;
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

  // Not reachable today and handled anyway. `internal_group` is exempt from
  // consent by design — ADM-70's trap: this announcement is not a client
  // communication, and suppressing it would silently stop the owner being told
  // what needs deciding.
  //
  // If it ever *is* reached, something has changed about what this
  // conversation is, and that is permanent rather than retryable: a retry
  // reads the same answer, and looping would hide the change.
  if (queued.outcome === 'no_consent') {
    return {
      status: 'failed',
      permanent: true,
      detail:
        'the approval announcement was suppressed for consent, which should be impossible for an internal group — the conversation kind has changed',
    };
  }

  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') {
    // Genuinely already announced. Only a `sent` row earns the short-circuit:
    // a `pending` or `failed` row means the provider was never reached or
    // refused, and returning success there is how a retry once reported an
    // announcement the owner never received. Those fall through and send.
    return {
      status: 'succeeded',
      outcome: 'already_announced',
      detail: `${event.reference} was already announced`,
    };
  }

  if (!queued.to_phone) {
    // A group with no provider id: linked in this system and never actually
    // created or mapped on WhatsApp's side. Permanent, because retrying does
    // not link a group — somebody has to.
    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'the internal group has no provider id to send to',
    });
    return {
      status: 'failed',
      permanent: true,
      detail: 'the internal group has no provider id to send to',
    };
  }

  const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

  const sent = await sendWhatsAppText({
    phoneNumberId: queued.from_phone_number_id ?? '',
    // The provider's group id, not a phone number — Meta's Groups API takes
    // `recipient_type: 'group'` with the group id in `to`. Both come from
    // send_outbound_message rather than being worked out here, so this handler
    // cannot get the pairing wrong.
    to: queued.to_phone,
    body: announcementFor(event),
    recipientType: queued.recipient_type ?? 'group',
  });

  const settled = await admin.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  if (settled.error) {
    // Reached the provider but could not record the outcome. Retryable so the
    // next run reconciles against the row's own delivery state.
    return { status: 'failed', permanent: false, detail: `could not record delivery: ${settled.error.message}` };
  }

  if (!sent.ok) {
    // A row that was already `sent` is terminal, so mark_outbound_delivery
    // returned false and left it alone — this attempt lost a race to a send
    // that already landed. Report success, not a failure the owner would
    // chase. Otherwise the failure stands, classified: a 4xx-not-429 is
    // permanent, everything else worth another attempt.
    if (settled.data === false) {
      return { status: 'succeeded', outcome: 'already_announced', detail: `${event.reference} was already announced` };
    }
    return { status: 'failed', permanent: sent.permanent, detail: `provider: ${sent.message}` };
  }

  return {
    status: 'succeeded',
    outcome: 'announced',
    detail: `${event.reference} announced in the internal group`,
  };
}


/**
 * Hand a claimed follow-up to the provider — gap G-012, decision ADM-69.
 *
 * The worker claims the attempt and writes the message through
 * `crm.send_outbound_message`, which leaves it `pending`. This is what makes
 * it actually go.
 *
 * ── why this is a job and not an inline call in the worker ────────────────
 *
 * The worker runs inside the cron tick, which has no retry budget, no backoff
 * and no parking. The job runner has all three and already drains other
 * handlers through the same generic loop. Calling the provider inline would
 * mean a transient provider blip silently loses a follow-up, or a second retry
 * subsystem exists for the same problem.
 *
 * ── why the recipient is recomputed rather than carried ───────────────────
 *
 * `send_outbound_message` is called again with the **same** `external_ref`. It
 * answers `already_sent` and hands back the recipient *as it is now* — the
 * same idempotent path the announcer relies on. Carrying the phone number in
 * the event payload would deliver to whatever was true when the attempt was
 * claimed, which is not the same thing after a retry.
 */
export async function deliverFollowUp(admin: Admin, job: AnnounceJob): Promise<HandlerResult> {
  // The dispatcher wraps the emitted event, so the follow-up's own fields are
  // under `event` — the same envelope the announcer reads.
  const payload = (job.payload?.event ?? null) as
    | { conversationId?: string; externalRef?: string; body?: string }
    | null;
  const conversationId = payload?.conversationId;
  const externalRef = payload?.externalRef;

  if (!conversationId || !externalRef) {
    // Permanent: a payload missing its own identity is not something a retry
    // repairs, and looping on it would hide whoever wrote it.
    return { status: 'failed', permanent: true, detail: 'the follow-up job carries no conversation or reference' };
  }

  // The conversation id comes from the event PAYLOAD — the untrusted half.
  // `send_outbound_message` takes no organization and derives the tenant, the
  // sender number and the recipient from the conversation row itself, on the
  // service-role client that bypasses RLS. So a `followup.queued` event forged
  // in one organization (anyone who may write an outbox event — an owner, over
  // PostgREST) naming ANOTHER organization's conversation would send from that
  // tenant's number into that tenant's thread. Scope the conversation to the
  // JOB's organization — the trusted half, set by the dispatcher from the
  // event's own organization_id — and refuse anything not in it. The sibling
  // handlers (handleApprovalRequested, handleInvoicePaid) scope by the job org
  // for exactly this reason; this one did not.
  const { data: convo, error: convoError } = await admin
    .schema('crm')
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (convoError) {
    // A read that failed is not a conversation in the wrong tenant. Retryable.
    return { status: 'failed', permanent: false, detail: `could not read the follow-up conversation: ${convoError.message}` };
  }
  if (!convo) {
    // Absent, or in another organization. Permanent: a retry reads the same
    // answer, and looping would hide whoever pointed a job across the tenant line.
    return { status: 'failed', permanent: true, detail: 'the follow-up conversation is not in this job’s organization' };
  }

  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: conversationId,
    p_body: payload?.body ?? '',
    p_external_ref: externalRef,
  });

  if (error) {
    return { status: 'failed', permanent: false, detail: `could not resolve the follow-up: ${error.message}` };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent';
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
        delivery: 'pending' | 'sent' | 'failed' | null;
      }
    | undefined;

  if (!queued) return { status: 'failed', permanent: false, detail: 'send_outbound_message answered nothing' };

  if (queued.outcome === 'not_found') {
    return { status: 'failed', permanent: true, detail: 'the conversation no longer exists' };
  }

  if (queued.outcome === 'no_consent') {
    // Consent was withdrawn between the claim and the delivery. Not a failure
    // and not retryable: the chokepoint is right, and the follow-up should not
    // go. ADM-70's suppression must hold at the last possible moment, not only
    // at the first.
    return { status: 'succeeded', outcome: 'suppressed', detail: 'consent was withdrawn before delivery' };
  }

  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') {
    // The attempt already reached the provider — this job was reaped after the
    // send landed but before the settle, or is a duplicate. Without this branch
    // the handler fell straight through and called the provider AGAIN, and a
    // client was double-messaged on the wire. A `sent` row means stop.
    return { status: 'succeeded', outcome: 'delivered', detail: 'the follow-up was already delivered' };
  }

  if (!queued.to_phone || !queued.message_id) {
    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'no recipient to send to',
    });
    return { status: 'failed', permanent: true, detail: 'no recipient to send to' };
  }

  const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

  const sent = await sendWhatsAppText({
    phoneNumberId: queued.from_phone_number_id ?? '',
    to: queued.to_phone,
    body: payload?.body ?? '',
    recipientType: queued.recipient_type ?? 'individual',
  });

  const settled = await admin.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  if (settled.error) {
    // The provider was reached but the outcome could not be recorded — the row
    // may be sent-but-unmarked. Retryable so the next run reconciles: the
    // derived external_ref finds the same row, and its delivery state (still
    // pending here) decides whether a resend is needed.
    return { status: 'failed', permanent: false, detail: `could not record delivery: ${settled.error.message}` };
  }

  if (!sent.ok) {
    // The row was already terminal — a concurrent attempt settled it as sent —
    // so this failure is stale and the message did land. Otherwise the failure
    // stands, classified: a bad recipient or malformed request (4xx-not-429)
    // will never send, so `permanent` parks the JOB rather than retrying to the
    // ceiling.
    if (settled.data === false) {
      return { status: 'succeeded', outcome: 'delivered', detail: 'the follow-up was already handed to the provider' };
    }
    // The SEQUENCE is deliberately left unchanged here. Stopping it on a
    // permanent send failure — so a never-delivered attempt cannot advance to a
    // false "client ignored us" escalation — was prototyped and rejected. Two
    // reasons, either fatal: (1) `sent.permanent` is any 4xx-not-429, which
    // lumps a FIXABLE deployment/window/auth fault (an expired token → 401, a
    // plain-text follow-up past WhatsApp's 24-hour window → 400) in with a
    // genuinely bad recipient — so a stop here would terminally kill live
    // sequences across every tenant during a token outage, with no un-stop path;
    // telling those apart needs Meta error-code facts (external-verification-
    // gated, like real sending). (2) Escalation is decided at CLAIM time in the
    // worker (`recordSent`), before this delivery runs, so a stop here cannot
    // prevent the final-attempt escalation anyway. The honest fix — escalate
    // only on delivered-and-unanswered attempts — belongs in the worker and is
    // blocked on those provider facts. See docs/deployment/production-readiness.md
    // (C3 caveat / P7).
    return { status: 'failed', permanent: sent.permanent, detail: `provider: ${sent.message}` };
  }

  return { status: 'succeeded', outcome: 'delivered', detail: 'the follow-up was handed to the provider' };
}

/**
 * `conversation.escalated` → say so in the internal group.
 *
 * Doc 09 §7 and §36. The agent stopping is only half an escalation; this is
 * the half that reaches a person. Written after finding that the first half
 * shipped alone — `agent_paused_at` appeared nowhere outside the migration
 * that created it, so a client was told somebody was coming and nobody was
 * told to come.
 *
 * Everything structural is `handleApprovalRequested`'s, deliberately: the same
 * internal-group lookup, the same three-layer idempotency with the key derived
 * from the **conversation** rather than from the job or the event, the same
 * treatment of an organization with no group as an ordinary state. A second
 * announcer would be a second thing to keep in step.
 */
export async function handleConversationEscalated(
  admin: Admin,
  job: AnnounceJob,
): Promise<HandlerResult> {
  const envelope = job.payload ?? {};

  const parsed = conversationEscalatedEventSchema.safeParse(envelope.event);
  if (!parsed.success) {
    return {
      status: 'failed',
      permanent: true,
      detail: `malformed conversation.escalated payload: ${parsed.error.issues[0]?.message ?? 'unparseable'}`,
    };
  }
  const event = parsed.data;

  const { data: group, error: groupError } = await admin
    .schema('crm')
    .from('conversations')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('kind', 'internal_group')
    .neq('status', 'abandoned')
    .maybeSingle();

  if (groupError) {
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

  /**
   * Who is waiting, scoped by hand to the job's organization.
   *
   * Best-effort: a name that cannot be read gives "an unnamed contact" rather
   * than losing the announcement. The point of the message is that somebody is
   * waiting, and that is true whether or not their name resolves.
   */
  const { data: contact } = await admin
    .schema('crm')
    .from('conversations')
    .select('contacts(full_name, phone)')
    .eq('id', event.conversation_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  const person = (contact?.contacts ?? null) as { full_name: string | null; phone: string | null } | null;
  const who = person
    ? [person.full_name, person.phone].filter(Boolean).join(' · ') || null
    : null;

  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: group.id,
    p_body: escalationAnnouncementFor({ who, reason: event.reason }),
    // Keyed on the CONVERSATION, so a redelivered event and a retried job
    // collapse onto one message. A second handover of the same thread cannot
    // happen — `hand_conversation_to_a_person` only ever sets a null column.
    p_external_ref: `escalated:${event.conversation_id}`,
  });

  if (error) {
    return { status: 'failed', permanent: false, detail: `could not record: ${error.message}` };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; delivery: 'pending' | 'sent' | 'failed' | null }
    | undefined;

  if (!queued) {
    return { status: 'failed', permanent: false, detail: 'send_outbound_message answered nothing' };
  }

  if (queued.outcome === 'not_found') {
    return { status: 'failed', permanent: true, detail: 'the internal group no longer exists' };
  }

  if (queued.outcome === 'no_consent') {
    return {
      status: 'failed',
      permanent: true,
      detail:
        'the escalation announcement was suppressed for consent, which should be impossible for an internal group — the conversation kind has changed',
    };
  }

  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') {
    return {
      status: 'succeeded',
      outcome: 'already_announced',
      detail: 'this conversation was already announced',
    };
  }

  return { status: 'succeeded', outcome: 'announced', detail: 'the internal group was told' };
}
