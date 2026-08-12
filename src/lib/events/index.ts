import 'server-only';

import { createClient } from '@/lib/db/server';

/**
 * Appends to core.outbox_events — ARCHITECTURE.md §9.
 *
 * Platform-level for the same reason recordAudit is: every module publishes
 * into one stream, and lib/ may not depend on modules/ (§3.2). An event says
 * what happened; it does not say who should care. That mapping lives in the
 * subscription catalog and is read by the job runner, which is what lets
 * `invoice.paid` unlock the next milestone later without finance ever learning
 * that projects exists.
 *
 * Written through the RLS-scoped client on purpose. The insert policy added in
 * migration 014 stamps the author's own organization and refuses a
 * pre-published row, so a caller can neither publish into another tenant nor
 * insert an event that the dispatcher will skip.
 *
 * **This path is not transactional, and one caller is left on it.** It opens
 * its own connection and inserts in its own transaction, always after the
 * state change it describes has committed — so a failure here leaves the state
 * written and the event gone. Not delayed: gone. An INSERT that failed leaves
 * no row, so there is nothing in the outbox to see and nothing to replay. This
 * comment used to claim the opposite, which is how audit finding D17 stayed
 * invisible.
 *
 * Every event a Postgres function can publish now goes through
 * `core.emit_event` instead, inside the transaction that writes the state —
 * `invoice.issued`, `invoice.voided`, `payment.recorded` and `invoice.paid`.
 * The one caller still here is `invoice.created`, because
 * generateInvoiceFromMilestone has no function behind it (gap G-078). It has
 * no subscriber, so losing one loses a notification nobody reads.
 *
 * Failure is therefore still logged rather than thrown, for the reason that
 * was always sound: a payment genuinely received must not be reported as
 * failed because its notification row did not insert. What has changed is that
 * the events where that trade-off actually cost something no longer take it.
 */
export type DomainEvent = {
  organizationId: string;
  /** `<module>.<entity>.<past-tense-verb>` — ARCHITECTURE.md §9.2. */
  type: string;
  subjectType: string;
  subjectId: string;
  payload?: Record<string, unknown>;
  correlationId?: string;
};

export async function emitEvent(event: DomainEvent): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .schema('core')
    .from('outbox_events')
    .insert({
      organization_id: event.organizationId,
      type: event.type,
      subject_type: event.subjectType,
      subject_id: event.subjectId,
      payload: (event.payload ?? {}) as never,
      correlation_id: event.correlationId ?? null,
    });

  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'emitEvent',
        type: event.type,
        detail: error.message,
      }),
    );
  }
}
