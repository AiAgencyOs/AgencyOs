import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { planJobsForEvent, type OutboxEvent } from './catalog';

/**
 * The outbox dispatcher — ARCHITECTURE.md §9.1, steps 4–7.
 *
 * Turns committed events into queued jobs:
 *
 *   4. claim unpublished events
 *   5. look up subscribers in the catalog
 *   6. enqueue one job per (event, handler), keyed `evt:<id>:<handler>`
 *   7. mark published_at
 *
 * **Enqueue before publish, never the other way round.** A crash between the
 * two leaves the event unpublished, so the next pass re-enqueues — and the
 * unique `dedupe_key` turns that into a no-op. The reverse order would lose
 * the job entirely, and a lost `invoice.paid` is a client who paid and whose
 * project never moved. At-least-once with a dedupe key is cheap; at-most-once
 * is not recoverable.
 *
 * Runs under the service role, which bypasses RLS. Everything below therefore
 * carries organization_id by hand, taken from the event row — never from its
 * payload, which is data a handler has yet to validate.
 *
 * Concurrency needs no lock. Two dispatchers may read the same event; both
 * plan the same jobs, one insert wins, the other hits 23505 and is counted as
 * a duplicate. Marking published is idempotent for the same reason.
 */

type Admin = ReturnType<typeof createAdminClient>;

/** Postgres unique violation — here, a job that was already enqueued. */
const UNIQUE_VIOLATION = '23505';

export type DispatchSummary = {
  scanned: number;
  enqueued: number;
  /** Already queued by an earlier pass or a racing dispatcher. Expected, not an error. */
  duplicates: number;
  published: number;
  /** Events with no subscriber. Published, because nobody listening is a complete outcome. */
  unsubscribed: number;
  failures: { eventId: number; detail: string }[];
};

export async function dispatchOutbox(
  admin: Admin,
  options: { batchSize?: number } = {},
): Promise<DispatchSummary> {
  const batchSize = options.batchSize ?? 25;

  const summary: DispatchSummary = {
    scanned: 0,
    enqueued: 0,
    duplicates: 0,
    published: 0,
    unsubscribed: 0,
    failures: [],
  };

  const { data: events, error } = await admin
    .schema('core')
    .from('outbox_events')
    .select('id, organization_id, type, subject_type, subject_id, payload')
    .is('published_at', null)
    .order('id', { ascending: true })
    .limit(batchSize);

  if (error) {
    summary.failures.push({ eventId: -1, detail: `could not read outbox: ${error.message}` });
    return summary;
  }

  for (const row of events ?? []) {
    summary.scanned += 1;

    const event = row as OutboxEvent;
    const planned = planJobsForEvent(event);

    if (planned.length === 0) summary.unsubscribed += 1;

    let enqueueFailed = false;

    // One insert per job rather than one batched insert: a duplicate on the
    // second handler must not roll back the first handler's job.
    for (const job of planned) {
      const { error: insertError } = await admin
        .schema('core')
        .from('jobs')
        .insert({
          organization_id: job.organization_id,
          kind: job.kind,
          payload: job.payload as never,
          dedupe_key: job.dedupe_key,
          correlation_id: null,
        });

      if (!insertError) {
        summary.enqueued += 1;
      } else if (insertError.code === UNIQUE_VIOLATION) {
        summary.duplicates += 1;
      } else {
        enqueueFailed = true;
        summary.failures.push({ eventId: event.id, detail: insertError.message });
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'dispatchOutbox',
            eventId: event.id,
            detail: insertError.message,
          }),
        );
      }
    }

    // An event whose jobs did not all land stays unpublished so the next pass
    // retries it. `attempts` is bumped so a permanently failing event is
    // visible in the outbox rather than silently spinning.
    if (enqueueFailed) {
      await admin
        .schema('core')
        .from('outbox_events')
        .update({ attempts: (await currentAttempts(admin, event.id)) + 1 })
        .eq('id', event.id);
      continue;
    }

    const { error: publishError } = await admin
      .schema('core')
      .from('outbox_events')
      .update({ published_at: new Date().toISOString() })
      .eq('id', event.id)
      .is('published_at', null);

    if (publishError) {
      summary.failures.push({ eventId: event.id, detail: publishError.message });
    } else {
      summary.published += 1;
    }
  }

  return summary;
}

async function currentAttempts(admin: Admin, eventId: number): Promise<number> {
  const { data } = await admin
    .schema('core')
    .from('outbox_events')
    .select('attempts')
    .eq('id', eventId)
    .maybeSingle();

  return data?.attempts ?? 0;
}
