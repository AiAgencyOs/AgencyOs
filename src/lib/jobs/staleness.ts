/**
 * When a job's worker is presumed dead — the rule, with no database attached.
 *
 * Separated from reaper.ts for the same reason events/catalog.ts is separated
 * from events/dispatch.ts: the decision is worth testing directly, and the
 * thing that executes it needs a service-role client that a test has no
 * business holding. Postgres remains the authority — `core.reap_stalled_jobs`
 * applies this rule in one atomic statement — and everything here mirrors that
 * predicate so the runner can describe what it is about to release.
 */

/**
 * How long a lock must be held before its owner is presumed dead.
 *
 * Derived from the one thing that actually bounds a worker's life: a Vercel
 * function cannot outlive its maximum duration. This deployment declares no
 * `maxDuration`, so the ceiling is the platform default of 300s, and the
 * highest value the plan would allow is 800s. A lock older than 800s therefore
 * cannot belong to a live invocation, whatever the route is later configured
 * to.
 *
 * 15 minutes is the smallest round threshold above that ceiling, leaving ~100s
 * for clock drift between the database and the function. Note this is
 * deliberately *not* the SQL function's own 5-minute default, which equals the
 * current ceiling exactly and would put reaping and a live worker on the same
 * instant — the one case that would cause the double-processing this whole
 * mechanism exists to avoid.
 *
 * The cost of being generous is bounded and dull: a stalled job waits up to
 * fifteen minutes before it retries. The cost of being aggressive is a second
 * runner on a job that was never actually dead.
 */
export const STALE_AFTER_SECONDS = 900;

/** The same threshold in the interval syntax `core.reap_stalled_jobs` takes. */
export const STALE_AFTER = '15 minutes';

/** The fields the recovery rule reads. */
export type ReapableJob = {
  status: string;
  locked_at: string | null;
  attempts: number;
  max_attempts: number;
};

/**
 * Whether a job's lock is old enough that its owner cannot still be alive.
 *
 * Mirrors the SQL predicate `status = 'running' and locked_at < now() -
 * stall_timeout`. A `running` row with no usable `locked_at` is not stale at
 * any age: absent a lock timestamp there is nothing to measure, and guessing
 * would mean reaping a row whose claim is merely mid-write.
 */
export function isStale(job: ReapableJob, nowMs: number): boolean {
  if (job.status !== 'running') return false;
  if (!job.locked_at) return false;

  const lockedAtMs = Date.parse(job.locked_at);
  if (Number.isNaN(lockedAtMs)) return false;

  return nowMs - lockedAtMs > STALE_AFTER_SECONDS * 1_000;
}

/**
 * What a stale job becomes.
 *
 * `attempts` was already incremented when the job was claimed, so a job that
 * has burned its budget is parked rather than released. That is what stops a
 * job which stalls every single time from being recovered forever: each rescue
 * costs an attempt, and the attempts run out.
 */
export function recoveryFor(job: ReapableJob): 'queued' | 'dead' {
  return job.attempts >= job.max_attempts ? 'dead' : 'queued';
}
