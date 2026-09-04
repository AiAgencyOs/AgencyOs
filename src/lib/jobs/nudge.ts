import 'server-only';

import { runnerAuthHeaders, runnerUrl } from './runner-address';

/**
 * Wake the runner now, instead of waiting for the clock — G-209.
 *
 * ── the finding ───────────────────────────────────────────────────────────
 *
 * There is no artificial delay anywhere in this codebase. The reply latency
 * comes from something less obvious and larger: **nothing runs when a message
 * arrives.** The webhook ingests, writes a `reply.due` outbox event and
 * returns. The agent only wakes when an external cron POSTs `/api/jobs/run`,
 * and that fires at `rate(1 minute)`.
 *
 * One tick does dispatch the event AND drain the job it creates — that was
 * worth checking, because it means the wait is ONE tick rather than two — but
 * a client still sits in silence for anywhere from zero to sixty seconds
 * before the agent begins to think, and the model's own time comes after
 * that. For a sales conversation on WhatsApp, that is the difference between
 * a person and a batch process.
 *
 * ── why this is safe, and why it cannot make anything worse ───────────────
 *
 * `core.claim_agent_job` claims with `for update skip locked`, and the unlock
 * path keys its update on `status = 'queued'`. Both were written for a second
 * runner: the code's own comment says *"a second runner's update matches zero
 * rows, so the same job cannot be handled twice concurrently."* So an extra
 * tick is not a new concurrency problem — it is the case the claiming was
 * designed for.
 *
 * And the failure mode is the status quo. If the nudge is unconfigured, times
 * out, is refused, or the request is dropped mid-flight, the work stays
 * exactly where it was: queued, waiting for the next cron tick, which is what
 * happens today on every message. **This can only remove waiting, never add
 * it** — which is why it is best-effort by design rather than by resignation,
 * and why a failure here is logged and swallowed rather than surfaced to
 * Meta as a webhook error.
 */
export async function nudgeRunner(reason: string): Promise<'sent' | 'skipped' | 'failed'> {
  const url = runnerUrl();
  const headers = runnerAuthHeaders();

  // Unset in local development and in every test that does not opt in. A nudge
  // that cannot authenticate would be answered 401 and do nothing, so not
  // sending it is the same outcome without the round trip.
  if (!url || !headers) return 'skipped';

  /**
   * ── the burst question, and why there is no window here ─────────────────
   *
   * One nudge per webhook REQUEST, not per message, so a batch from Meta
   * rings once. A hundred separate requests in a minute would still start a
   * hundred invocations, and it is worth being precise about what that does:
   * **the total model work is unchanged** — it is bounded by what is queued,
   * not by how often the runner is asked to look — and `for update skip
   * locked` was written for concurrent runners. What rises is invocations.
   *
   * A five-second "the runner just ran, ride that tick" window was built here
   * and then REMOVED, because a live run showed what it costs. The tick's
   * stages are ordered — dispatch, then the agent drain — so a message
   * arriving after the dispatch stage of a running tick is not picked up by
   * it, and suppressing the nudge hands that client the full minute this
   * whole change exists to remove. A bound that occasionally restores the
   * exact defect is a bad trade for saving invocations.
   *
   * If inbound volume ever makes invocations the binding constraint, the
   * control belongs at the edge with the rest of the webhook's rate limiting
   * (audit SE-A), not in a timing guess here.
   */
  try {
    await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
      // Deliberately short. This is a doorbell, not a request whose answer we
      // need: the tick it starts runs in its own invocation and takes as long
      // as it takes. Waiting for it would tie this webhook's lifetime to the
      // agent's, which is the coupling the cron exists to avoid.
      signal: AbortSignal.timeout(1_500),
    });
    return 'sent';
  } catch (error) {
    // Includes the deliberate abort, so the common case of this catch block
    // is SUCCESS — the doorbell rang and we stopped listening. `warn` rather
    // than `error` for that reason: an error line here would page somebody
    // every time the system worked as designed.
    console.warn(
      JSON.stringify({
        level: 'warn',
        scope: 'nudgeRunner',
        reason,
        detail: error instanceof Error ? error.message : String(error),
        note: 'the work stays queued for the next scheduled tick',
      }),
    );
    return 'failed';
  }
}
