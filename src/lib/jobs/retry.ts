/**
 * When a failed job may be tried again — the rule, with no database attached.
 *
 * Separated from the runner for the same reason staleness.ts is separated from
 * reaper.ts: the decision is worth testing directly, and the thing that
 * executes it needs a service-role client that a test has no business holding.
 *
 * Audit finding D18. Both settle paths in `app/api/jobs/run/route.ts` wrote
 * `status = 'queued'` on a retryable failure and left `run_at` alone. Nothing
 * anywhere in the application has ever written `run_at` — it only took its
 * `default now()` at insert — so a requeued job was immediately eligible
 * again.
 *
 * On the unlock path that is not a slow retry, it is no retry at all. The
 * drain loop runs up to `UNLOCK_BATCH = 10` times per invocation and claims the
 * oldest queued row; a job requeued with its original `run_at` is still the
 * oldest, so the very next iteration re-claims it. Five iterations exhaust
 * `max_attempts` and the fifth settle parks it `dead` — the whole retry budget
 * spent inside a few hundred milliseconds of one cron tick.
 *
 * What that costs is exactly what findings D5 and D15 went to trouble to
 * protect. Both made a failed *read* retryable rather than permanent,
 * specifically so a transient database blip would not strand a milestone the
 * client had already paid for. This defect meant there was no "later": all
 * five attempts happened inside the same blip, and the job was dead before the
 * database had finished recovering.
 *
 * Postgres is not the authority here, unlike the reaper's rule — but the clocks
 * are worth being exact about rather than waving at. A `run_at` written by this
 * rule is the application's clock, and the claim filters `run_at <= new Date()`
 * on that same clock, so a *retry* is scheduled and read consistently. The
 * initial `run_at` is not: it comes from the column's `default now()`, which is
 * the database's clock, and the claim has always compared it against the
 * application's. That crossing predates this rule and is left alone, because
 * the smallest delay here is a minute and the skew between a Vercel function
 * and Supabase is milliseconds — but it is a crossing, not an absence of one.
 */

/** The fields the retry rule reads. */
export type RetryableJob = {
  /**
   * Attempts **already made**, including the one that just failed.
   *
   * The two callers reach this number differently and both are correct: the
   * unlock path increments `attempts` when it claims and carries the new value,
   * while the extraction path holds the row as it was before the claim and so
   * passes `attempts + 1`. Naming it for what it means rather than for the
   * column is what keeps that from being a silent off-by-one.
   */
  attemptsMade: number;
  maxAttempts: number;
};

/**
 * The first retry delay, and the step the rest double from.
 *
 * One minute because that is the cron cadence. A job released sooner is not
 * tried sooner — it simply sits `queued` until the next tick — so any smaller
 * value buys nothing and only narrows the window this exists to open.
 */
export const RETRY_BASE_SECONDS = 60;

/**
 * The ceiling on a single delay.
 *
 * Fifteen minutes, matching `STALE_AFTER` in staleness.ts, so the two ways a
 * job can be waiting are bounded by the same number rather than by two numbers
 * that have to be reconciled when someone asks how long a job can be stuck.
 *
 * With the default `max_attempts` of 5 the cap is never reached — the fourth
 * and last delay is 8 minutes. It binds only for a row configured to try more
 * often than that, which is the case where an unbounded doubling would
 * otherwise put an attempt hours away.
 */
export const RETRY_MAX_SECONDS = 900;

/**
 * How long to wait before the next attempt.
 *
 * Exponential from the cron cadence: 1, 2, 4, 8 minutes, then capped. Four
 * retries therefore span 15 minutes of *nominal* delay.
 *
 * Wall-clock is longer, and worth stating rather than rounding away. `run_at`
 * is stamped at settle time — a few hundred milliseconds after the tick that
 * claimed the job — so a delay of exactly one cron period lands just after the
 * tick it was aimed at, and waits for the following one. Each rung therefore
 * rounds up: the effective ladder is nearer 2, 3, 5 and 9 ticks, and the five
 * attempts span roughly 19 minutes rather than 15.
 *
 * That window is sized for the failures this actually serves — a failover, a
 * connection-pool exhaustion, a deploy — and it is deliberately not sized for
 * a long outage. A database degraded for half an hour still ends with the job
 * `dead`, which is the D5/D15 outcome this whole classification exists to
 * avoid. Making the budget outlast that is a policy question rather than an
 * engineering one (how long may a paid milestone stay shut?), and it is raised
 * as ADM-39 rather than answered here.
 *
 * No jitter, deliberately. Jitter answers a thundering herd, and there is no
 * herd to answer: the unlock loop claims one row at a time with `limit 1` and a
 * compare-and-swap, and drains at most `UNLOCK_BATCH` per tick, so a hundred
 * jobs coming due at the same instant are already serialised into ten per
 * minute by the claim itself. Adding randomness would only make the delay
 * untestable.
 */
export function retryDelaySeconds(attemptsMade: number): number {
  // Defensive rather than expected: `attemptsMade` is at least 1 on every path
  // that reaches a settle, because settling happens after a claim.
  const step = Math.max(1, Math.floor(attemptsMade));

  // 2^30 seconds already exceeds the cap by orders of magnitude; bounding the
  // exponent keeps a pathological `max_attempts` from producing Infinity and
  // an invalid date.
  const doublings = Math.min(step - 1, 30);

  return Math.min(RETRY_BASE_SECONDS * 2 ** doublings, RETRY_MAX_SECONDS);
}

/** What becomes of a job that has just failed. */
export type Settlement =
  | { status: 'dead' }
  | { status: 'queued'; runAt: string; delaySeconds: number };

/**
 * Whether a failed job is retried, and when.
 *
 * `permanent` short-circuits everything: a wrong organization, a voided
 * invoice, an event naming a milestone that is not next — none of those become
 * true by waiting, and parking them immediately is what stops the queue filling
 * with work that can only fail. That distinction is D5's, and it is preserved
 * here exactly; what changes is only the timing of the retryable half.
 *
 * A job that has spent its budget is `dead` and carries no `runAt`, so a caller
 * cannot accidentally schedule a row it has just parked.
 */
export function settlementFor(job: RetryableJob, permanent: boolean, nowMs: number): Settlement {
  if (permanent || job.attemptsMade >= job.maxAttempts) return { status: 'dead' };

  const delaySeconds = retryDelaySeconds(job.attemptsMade);

  return {
    status: 'queued',
    delaySeconds,
    runAt: new Date(nowMs + delaySeconds * 1_000).toISOString(),
  };
}
