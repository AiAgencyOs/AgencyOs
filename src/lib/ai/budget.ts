/**
 * How long the model call may take, derived from what actually bounds it.
 *
 * The job runner is a serverless function with a wall clock. Left at the SDK's
 * defaults the extraction call could outlive that clock several times over —
 * ten minutes per attempt, retried twice — so the platform, not the
 * application, decided how the job ended. A killed invocation cannot run its
 * own settlement writes, which is how a claimed job was left `running` with
 * nothing to recover it but the reaper, fifteen minutes later.
 *
 * Every number below is taken from a real constraint. None is a preference.
 *
 * Kept free of `server-only` and of the SDK so the arithmetic can be asserted
 * directly, the way src/lib/jobs/staleness.ts is separated from reaper.ts.
 */

/**
 * The invocation's hard ceiling.
 *
 * `app/api/jobs/run/route.ts` declares no `maxDuration`, so it runs at the
 * platform default, which Vercel documents as 300s on every plan with fluid
 * compute. A test pins the absence of that declaration, so this constant and
 * the route cannot drift apart silently.
 *
 * If a `maxDuration` is ever added, this is the number that must move with it.
 */
export const FUNCTION_CEILING_MS = 300_000;

/**
 * Everything in an invocation that is not the model call.
 *
 * Two jobs. First it covers the real work either side of the call: the reaper's
 * two queries, an outbox dispatch of up to 25 events, the six queries that
 * claim the job and load the transcript, and cold start. Measured, that path
 * runs in well under a second when idle and a handful of seconds at its worst.
 *
 * Second, and the reason it is this large: it is the budget for the settlement
 * writes *after* a timeout. When the call fails, the runner still has to record
 * the step, close the run and requeue the job. Those writes are what make a
 * timeout recoverable on the next tick instead of a stall the reaper has to
 * clean up a quarter of an hour later, so they must not be the thing the
 * platform cuts off. Reserving roughly an order of magnitude more than measured
 * is cheap here; the only cost is a shorter model timeout.
 */
export const NON_MODEL_RESERVE_MS = 60_000;

/**
 * Retries inside the function.
 *
 * Deliberately one, not the SDK's two. The queue already retries: a failed job
 * is requeued by `failJob`, cron runs every minute, and `max_attempts` bounds
 * the whole thing. A retry there costs a minute of latency and no wall clock at
 * all, while a retry here is spent from the same 300s the model call is
 * competing for.
 *
 * So the in-function retry earns its place only for failures that a whole tick
 * of waiting would not improve — a dropped socket, a 429, a 529 — where a
 * sub-second backoff is enough. Anything worse belongs to the queue.
 */
export const MAX_RETRIES = 1;

/**
 * Worst-case backoff the SDK sleeps between attempts.
 *
 * Its schedule is `min(0.5 * 2^n, 8)` seconds with up to 25% jitter *removed*,
 * so 500ms is the ceiling for the first retry, not an average. Included in the
 * arithmetic rather than waved away, because it is spent from the same budget.
 */
export function retryBackoffWorstCaseMs(retries: number = MAX_RETRIES): number {
  let total = 0;
  for (let n = 0; n < retries; n += 1) total += Math.min(0.5 * 2 ** n, 8) * 1_000;
  return total;
}

/**
 * The per-attempt timeout handed to the Anthropic client.
 *
 * Derived: (ceiling − reserve − backoff) ÷ attempts is 119.75s, rounded down to
 * 110s so the figure is legible and the margin is deliberate rather than
 * whatever the division happened to leave.
 *
 * Comfortably longer than a structured extraction of this size needs. An
 * extraction that genuinely cannot finish inside it fails cleanly, records why,
 * and is retried by the queue — which is the honest outcome, and a better one
 * than being killed mid-flight with nothing written down.
 */
export const REQUEST_TIMEOUT_MS = 110_000;

/** The longest the provider call can take, retries and backoff included. */
export function providerWorstCaseMs(): number {
  return (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + retryBackoffWorstCaseMs();
}

/**
 * What is left of the invocation after the provider has taken its worst case.
 *
 * Positive by construction. The test suite asserts it, so a later change to any
 * constant here that would let the model call reach the platform's ceiling
 * fails the build rather than production.
 */
export function remainingBudgetMs(): number {
  return FUNCTION_CEILING_MS - NON_MODEL_RESERVE_MS - providerWorstCaseMs();
}
