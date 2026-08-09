import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { recoveryFor, STALE_AFTER, STALE_AFTER_SECONDS } from './staleness';

/**
 * Recovery for jobs whose worker died mid-run.
 *
 * A job is claimed by flipping it to `running` and stamping `locked_at`. Every
 * claim path filters on `status = 'queued'`, which is what stops two runners
 * from taking the same row — and is also why an invocation killed between the
 * claim and the settlement strands its job forever: nothing else moves a row
 * out of `running`. Before this ran, a single platform timeout meant a paid
 * invoice whose milestone never opened, with no path back.
 *
 * The work itself is `core.reap_stalled_jobs`, which has been in the schema
 * since the first core migration and is granted to `service_role` alone. It is
 * one UPDATE, so it is atomic: two runners reaping concurrently cannot both
 * release the same row, because by the time the second one's predicate is
 * re-evaluated the row has left `running`. This module supplies the threshold
 * and reports what happened; it deliberately does not reimplement the rule.
 */

type Admin = ReturnType<typeof createAdminClient>;

/** How many stale rows are described in the summary. Reaping itself is unbounded. */
const OBSERVE_LIMIT = 100;

export type ReapSummary = {
  /**
   * Rows the database actually released. Authoritative — it is the UPDATE's own
   * row count, not something inferred.
   */
  reclaimed: number;
  /** Of the rows observed just beforehand, how many go back on the queue. */
  requeued: number;
  /** Of those, how many had spent their attempts and are parked as `dead`. */
  parkedDead: number;
  /** Distinct organizations among them. Reaping never crosses one. */
  organizations: number;
  failures: string[];
};

/**
 * Releases every stale job, and reports what was released.
 *
 * Safe on every tick and safe alongside another runner doing the same: the
 * threshold makes it a no-op unless something genuinely died, and the UPDATE
 * makes a second caller's work empty rather than duplicated.
 *
 * The observation query runs first and is advisory — it exists so the runner
 * can say which organizations were touched and how many jobs are being given up
 * on. `reclaimed` comes from the database and is what should be trusted; the
 * two can differ by a row when another runner reaps in between, or by a moment
 * of clock drift, both of which are expected rather than errors.
 */
export async function reapStalledJobs(admin: Admin): Promise<ReapSummary> {
  const summary: ReapSummary = {
    reclaimed: 0,
    requeued: 0,
    parkedDead: 0,
    organizations: 0,
    failures: [],
  };

  const cutoff = new Date(Date.now() - STALE_AFTER_SECONDS * 1_000).toISOString();

  const { data: observed, error: observeError } = await admin
    .schema('core')
    .from('jobs')
    .select('id, organization_id, attempts, max_attempts, locked_at, status')
    .eq('status', 'running')
    .lt('locked_at', cutoff)
    .order('locked_at', { ascending: true })
    .limit(OBSERVE_LIMIT);

  if (observeError) {
    // Not fatal. The release below is the part that matters, and it does not
    // depend on anything read here.
    summary.failures.push(`could not describe stalled jobs: ${observeError.message}`);
  }

  const organizations = new Set<string>();
  for (const row of observed ?? []) {
    organizations.add(row.organization_id);
    if (recoveryFor(row) === 'dead') summary.parkedDead += 1;
    else summary.requeued += 1;
  }
  summary.organizations = organizations.size;

  const { data: reclaimed, error: reapError } = await admin
    .schema('core')
    .rpc('reap_stalled_jobs', { stall_timeout: STALE_AFTER });

  if (reapError) {
    summary.failures.push(`could not reap stalled jobs: ${reapError.message}`);
    console.error(
      JSON.stringify({ level: 'error', scope: 'reapStalledJobs', detail: reapError.message }),
    );
    return summary;
  }

  summary.reclaimed = reclaimed ?? 0;
  return summary;
}
