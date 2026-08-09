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
 * Failure is logged, never thrown — same reasoning as recordAudit. A state
 * change that has already committed must not be reported as failed because its
 * notification row did not insert. The cost is an event that never fires,
 * which is visible in the outbox and replayable; the alternative is refusing a
 * payment that has genuinely been received.
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
