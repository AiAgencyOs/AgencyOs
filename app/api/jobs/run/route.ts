import { NextResponse, type NextRequest } from 'next/server';

import { authorizeCronRequest } from '@/lib/cron-auth';
import { createAdminClient } from '@/lib/db/admin';
import { failJob, logJobParked, type Admin, type JobRow } from './agent-run';
import { AGENT_JOB_KINDS, workflowFor } from './workflows';
import { serverEnv } from '@/lib/env';
import { newCorrelationId } from '@/lib/errors';
import { HANDLER_JOB_KIND } from '@/lib/events/catalog';
import { dispatchOutbox } from '@/lib/events/dispatch';
import { reapStalledJobs } from '@/lib/jobs/reaper';
import { expireOverdueApprovals } from '@/lib/approvals/expire';
import { lapseOverdueProposals } from '@/lib/sales/lapse';
import { runFollowUps } from '@/modules/crm/follow-up-worker';
import { detectUpsellSignals } from '@/lib/sales/upsell';
import { markOverdueInvoices } from '@/lib/finance/overdue';
import { mayAgentRun } from '@/lib/ai/autonomy';
import { alertOnBacklog } from '@/lib/observability/alert';
import { stampAgentDefinitions } from '@/modules/agents/stamp';
import { settlementFor } from '@/lib/jobs/retry';
import { handleApprovalRequested, deliverFollowUp } from '@/modules/crm/handlers';
import { handleInvoicePaid, type HandlerResult, type UnlockJob } from '@/modules/projects/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/jobs/run — the job runner.
 *
 * One of the four sanctioned service-role call sites (ARCHITECTURE.md §7.3).
 * It exists because `ai.agent_runs` has no INSERT policy for authenticated
 * users by design — "an agent trace nobody can forge is the point" — so the
 * only principal that may record a run is the one running behind this route.
 *
 * Because the service role bypasses RLS entirely, every query below scopes by
 * organization_id **by hand**, taken from the job row rather than from request
 * input. Nothing here trusts the caller for tenancy.
 *
 * Authentication is a shared secret. When CRON_SECRET is unset the route is
 * inert (503) rather than open.
 *
 * In production the caller is Vercel Cron, configured in `vercel.json` to hit
 * this path every minute. Vercel issues cron invocations as **GET**, so the
 * GET export at the bottom of this file is the scheduler's entry point; it
 * delegates to POST, which remains the handler and the only implementation.
 */

/**
 * Where a claimed extraction job is parked so a throw can still settle it.
 *
 * Gap G-081. Everything between claiming that job and the final settle — a
 * transcript read, a model call, a validated insert — can throw rather than
 * return an error, and a database blip is precisely when a client throws. The
 * settle then never ran, and the row sat `running` with its attempt spent
 * until the reaper released it fifteen minutes later.
 *
 * A holder rather than a `try` around the body, because the body is three
 * hundred lines with fifteen exits: wrapping it in place would have been a
 * reindent of all of them, which is a large diff to hide a mistake in for a
 * ten-line fix.
 */
type ClaimHolder = { job: JobRow | null };

/**
 * What a job row looks like once it has actually succeeded.
 *
 * `last_error` is cleared, and that is the part worth naming.
 * `core.requeue_job` deliberately KEEPS the error when it revives a dead job —
 * *"it is the only record of why the work stopped, the operator read it before
 * deciding to requeue, and clearing it would erase the reason at the exact
 * moment somebody acted on it."* True right up until the work succeeds. After
 * that the row reads `succeeded` beside the reason it died in a previous life,
 * which is what production showed after the first extraction ever to work.
 *
 * `settleUnlockJob` already settled this way; the four extraction paths did
 * not, and one of them left the lock fields set as well. Same concept, four
 * spellings — so it is one shape now.
 */

export async function POST(request: NextRequest) {
  const claimed: ClaimHolder = { job: null };

  try {
    return await runTick(request, claimed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'jobs/run',
        jobId: claimed.job?.id ?? null,
        detail: `tick threw: ${detail}`,
      }),
    );

    // Settled with the same budget any other failure gets, so the retry is
    // spaced (D18) rather than waiting on the reaper. If nothing was claimed
    // there is nothing to settle and the throw was in the dispatch or reap
    // stage, which own no row.
    if (claimed.job) {
      try {
        await failJob(createAdminClient(), claimed.job, `runner threw: ${detail}`);
      } catch (settleError) {
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'jobs/run',
            jobId: claimed.job.id,
            detail: `could not settle after a throw: ${
              settleError instanceof Error ? settleError.message : String(settleError)
            }`,
          }),
        );
      }
    }

    return NextResponse.json({ error: 'runner failed' }, { status: 500 });
  }
}

async function runTick(request: NextRequest, claimed: ClaimHolder) {
  const { CRON_SECRET } = serverEnv();

  const auth = authorizeCronRequest(request.headers.get('authorization'), CRON_SECRET);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const correlationId = newCorrelationId();

  // The pulse, first thing after authentication: a tick that ran is recorded
  // as having run even if the work below throws, because the heartbeat is
  // about whether the SCHEDULER is alive, not whether this tick succeeded. A
  // dead scheduler is the one failure the in-tick alert path cannot report;
  // /api/health reads this age so something outside can. Best-effort — a
  // heartbeat write that fails must not stop the work the tick exists to do.
  await admin.schema('core').rpc('record_cron_tick');

  /**
   * ── recovery ───────────────────────────────────────────────────────────
   *
   * First, because a job stranded in `running` by a killed invocation is
   * invisible to every claim below — they all filter on `queued` — so until
   * something releases it the work is simply lost. Reaping ahead of the claims
   * means a recovered job is picked up on this tick rather than the next.
   *
   * A no-op unless something genuinely died: the threshold is longer than any
   * invocation can live (src/lib/jobs/reaper.ts).
   */
  const reaped = await reapStalledJobs(admin);

  /**
   * ── outbox → jobs (ARCHITECTURE.md §9.1, steps 4–7) ───────────────────
   *
   * Runs first on every invocation, and unconditionally. Events are written
   * by request-path code that has already committed its state change; until
   * something turns them into jobs they are a record of an intention nobody
   * acted on. Doing it here rather than in a separate cron entry keeps the
   * gap between "invoice paid" and "milestone open" to one tick.
   */
  const dispatched = await dispatchOutbox(admin);

  /**
   * ── monitoring (G-053) ────────────────────────────────────────────────
   *
   * After recovery and dispatch, so the counts describe what this tick could
   * not fix rather than what it was about to. A job still `dead` after the
   * reaper ran is genuinely dead; an event still unpublished after the
   * dispatcher ran is genuinely stuck.
   *
   * Never allowed to fail the tick. Moving work is this route's job; if the
   * alert endpoint is unreachable the work still runs and the failure is
   * logged, because a dead webhook stopping the job runner would turn
   * monitoring into an outage.
   */
  /**
   * ── unanswered approvals (G-096, ADM-08c) ─────────────────────────────
   *
   * Before the backlog is measured, so a request that expires on this tick is
   * counted as overdue by the alert rather than reported next minute. It
   * cannot approve anything — there is no path from expiry to approved, and
   * the function that writes approvals refuses a caller with no identity,
   * which this is.
   */
  const expired = await expireOverdueApprovals(admin);

  /**
   * ── quotations whose validity date has passed (G-111, ADM-71) ─────────
   *
   * The same shape one schema over, for the same reason: a quote nobody
   * answered kept reading `sent`, so a queue of outstanding quotations
   * counted it forever and nothing said it had gone cold.
   *
   * It marks state and stops. ADM-79 adds no notification — telling a client
   * their offer expired is a sales action a human takes, and an automated
   * message would be client-facing communication whose consent policy
   * (ADM-81) is still open.
   */
  const lapsed = await lapseOverdueProposals(admin);

  /**
   * ── opportunities worth telling the team about (G-036) ────────────────
   *
   * §2.7: AgencyOS may *identify* an opportunity and tell the team, and must
   * never state a price. This writes a row; it contacts nobody, and the table
   * has no column a price could go in.
   */
  const upsell = await detectUpsellSignals(admin);

  /**
   * ── follow-ups (G-012, ADM-69) ────────────────────────────────────────
   *
   * Observe, revalidate, claim, send, record — beside the other sweeps and
   * on the same runner, because ADM-69's work is the same shape as theirs and
   * a second queue would be a second set of retry, tenancy and idempotency
   * rules to keep in step.
   *
   * On a deployment with no agency timezone set, every sequence is blocked
   * with `timezone_unavailable` and nothing is sent (G-137). That is the
   * honest state: the alternative is guessing an hour.
   */
  const followUps = await runFollowUps(admin);

  /**
   * ── invoices whose date has passed (G-004) ────────────────────────────
   *
   * The transition INVOICE_TRANSITIONS has admitted since the first day and
   * nothing ever performed. It marks state and stops — chasing the client is
   * a message, and that waits on the outbound policy rather than arriving
   * behind a status change.
   */
  const overdue = await markOverdueInvoices(admin);

  /**
   * ── the agent registry, stamped against its definitions ────────────────
   *
   * ADM-83's `definition_version` and `last_validated_at` had no producer in
   * production: the only writer was a verification script that targets the
   * isolated database by design. Both columns were NULL on every production
   * row and `/agents` showed every agent as `never` validated — a field that
   * is always empty teaches a reader to stop looking at it.
   *
   * Cheap in the steady state: it reads the defined keys and writes only rows
   * whose stamp is not already the current revision, so an unchanged registry
   * costs one select per tick and no write at all.
   */
  const stamps = await stampAgentDefinitions(admin);

  const alerted = await alertOnBacklog(admin);

  /**
   * ── milestone unlocks ─────────────────────────────────────────────────
   *
   * Drained before the extraction path below because these are pure database
   * work — no model call, no network — so a batch of them costs milliseconds
   * and holding up the revenue path behind an AI job would be the wrong
   * priority. The batch is bounded, and cron runs every minute, so extraction
   * waits at most one tick behind a burst of unlocks.
   */
  const unlocks = await runEventJobs(
    admin,
    UNLOCK_JOB_KIND,
    handleInvoicePaid,
    'runUnlockJobs',
  );
  if (unlocks.claimed > 0) {
    return NextResponse.json({
      claimed: unlocks.claimed,
      kind: UNLOCK_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      overdue,
      stamps,
      unlocks: unlocks.results,
      correlationId,
    });
  }

  /**
   * ── approval announcements (G-110) ────────────────────────────────────
   *
   * After unlocks, before extraction. This one reaches an outside provider, so
   * it is not the pure database work above and does not belong ahead of the
   * revenue path — but it is a single request rather than a model call, and an
   * owner waiting to hear that a quotation needs signing should not queue
   * behind an AI job.
   *
   * Which provider is deliberately not named here, and not only in prose: the
   * runner claims, hands off and settles, and the handler owns every fact
   * about where the message goes. `tests/cron-scheduler.test.ts` enforces
   * that by refusing the word in this file.
   */
  const announcements = await runEventJobs(
    admin,
    ANNOUNCE_JOB_KIND,
    handleApprovalRequested,
    'runAnnounceJobs',
  );

  /**
   * ── follow-up delivery (G-012, ADM-69) ────────────────────────────────
   *
   * The follow-up worker claims an attempt and writes the message; this hands
   * it to the provider. Drained through the same generic loop as the
   * announcements, so it inherits the retry budget, the backoff and the
   * parking rather than growing its own — and for the same reason there is no
   * early return here either.
   */
  const followUpDeliveries = await runEventJobs(
    admin,
    FOLLOWUP_JOB_KIND,
    deliverFollowUp,
    'runFollowUpDeliveryJobs',
  );
  /**
   * **No early return here**, and that is the fix rather than an oversight.
   *
   * It had one, copied from the unlock drain above. The unlock path can afford
   * it: those are milliseconds of pure database work, so a tick that spends
   * itself on them has spent almost nothing. An announcement reaches an
   * outside provider, which makes it the same shape as the extraction path
   * below — and returning here meant **a single queued announcement starved
   * every later queue for that whole invocation**.
   *
   * Demonstrated rather than reasoned about: with one announce job queued, a
   * tick answered `{"claimed":1,"kind":"approval.announce"}` and left
   * `requirement.extract` untouched at `queued`, attempts 0. In CI, where the
   * scripts drive the runner directly rather than waiting for cron, that broke
   * `verify-requirement-proposal`'s concurrency section twice with the same
   * signature: two runners, neither reaching extraction, both answering with
   * no `reason` because this branch does not set one.
   *
   * The wall clock stays bounded: announcements are capped by the same batch
   * size as unlocks, and the extraction path below claims exactly one job.
   */

  // ── claim one agent job, whichever agent it belongs to ──────────────────
  //
  // `AGENT_JOB_KINDS` rather than one constant. Until this change the runner
  // claimed a single hard-coded kind, so twelve of the thirteen agents ADM-82
  // defined could be enabled and still receive nothing — the queue they would
  // have been fed from was never read. `claim_jobs` takes one kind, so the
  // kinds are tried in order and the first row claimed wins; `for update skip
  // locked` means a second runner steps over a locked row rather than
  // contending for it.
  //
  // One job per invocation, as before: claiming more would leave rows
  // `running` that nothing in this tick will settle.
  let claimedRow: unknown = null;

  for (const kind of AGENT_JOB_KINDS) {
    const { data: claimedJobs, error: claimError } = await admin
      .schema('core')
      .rpc('claim_jobs', {
        p_worker_id: `jobs-run:${correlationId}`,
        p_kind: kind,
        p_batch_size: 1,
      });

    if (claimError) {
      // Not "nothing queued": a claim that failed says nothing about the
      // queue, and answering `claimed: 0` would report an empty backlog on
      // exactly the blip that caused it.
      console.error(
        JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `claim failed: ${claimError.message}` }),
      );
      return NextResponse.json({ error: 'could not claim a job' }, { status: 503 });
    }

    claimedRow = (claimedJobs ?? [])[0] ?? null;
    if (claimedRow) break;
  }

  if (!claimedRow) {
    return NextResponse.json({
      claimed: 0,
      reaped,
      dispatched,
      followUps,
      unlocks: unlocks.results,
      announcements: announcements.results,
      followUpDeliveries: followUpDeliveries.results,
      correlationId,
    });
  }

  const job = claimedRow as JobRow;
  claimed.job = job;

  // ── which agent is this job for? ────────────────────────────────────────
  //
  // The job's kind decides, not a constant. A kind with no workflow is a job
  // nothing can perform; it fails loudly rather than being claimed forever by
  // a runner that has no idea what to do with it.
  const workflow = workflowFor(job.kind);

  if (!workflow) {
    await failJob(admin, job, `no agent workflow is registered for job kind "${job.kind}"`);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'no workflow' });
  }

  // ── agent registry: model, ceilings and kill switch are data, not code ──
  const { data: agent } = await admin
    .schema('ai')
    .from('agents')
    .select('key, enabled, default_model, default_effort, autonomy_level')
    .eq('key', workflow.agentKey)
    .maybeSingle();

  if (!agent) {
    await failJob(admin, job, `agent "${workflow.agentKey}" is not registered`);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'agent missing' });
  }

  if (!agent.enabled) {
    await failJob(admin, job, `agent "${workflow.agentKey}" is disabled`);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'agent disabled' });
  }

  // The level AND the work. A level-only gate refused every L2 agent using an
  // argument written about one path; ADM-61 distinguishes by what the work is,
  // so the gate does too.
  const autonomy = mayAgentRun(agent.autonomy_level, workflow.workClass);
  if (!autonomy.allowed) {
    await failJob(admin, job, `agent "${workflow.agentKey}": ${autonomy.reason}`);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'agent autonomy' });
  }

  // ── and then the work, which is the only part that differs ──────────────
  const outcome = await workflow.run({ admin, job, agent, correlationId, workClass: workflow.workClass });

  return NextResponse.json({ claimed: 1, correlationId, agent: workflow.agentKey, ...outcome });
}

export async function GET(request: NextRequest) {
  return POST(request);
}


// ═══════════════════════════════════════════════════════════════════════════
// invoice.paid → next milestone
//
// The consumer half of the revenue path. The dispatcher above has already
// turned `invoice.paid` events into `milestone.unlock` jobs; this claims them
// and hands each to the projects module's handler, which owns every decision.
// Nothing here inspects a payload or judges a milestone — the runner's job is
// claiming, settling and reporting.
// ═══════════════════════════════════════════════════════════════════════════

const UNLOCK_JOB_KIND = HANDLER_JOB_KIND['projects:unlockNextMilestone'];
const ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceApproval'];
const FOLLOWUP_JOB_KIND = HANDLER_JOB_KIND['crm:deliverFollowUp'];

/**
 * How many unlocks one invocation drains.
 *
 * Bounded because a serverless function has a wall clock. Cron runs every
 * minute, so a larger backlog simply takes a few more ticks; an unbounded loop
 * would instead be killed mid-job and leave rows locked for the reaper.
 */
const UNLOCK_BATCH = 10;

type ClaimedUnlockJob = UnlockJob & { attempts: number; max_attempts: number };

/**
 * Drain one kind of event-driven job.
 *
 * Generic over the kind and the handler because the claim, the retry budget,
 * the backoff and the parking are identical for every one of them, and a
 * second copy of this loop is how a fix stops applying to half the queue —
 * D16, where RLS drifted wider than the code guarding it, and D18, whose
 * backoff would have had to be remembered twice.
 *
 * `scope` is the label the logs carry, so a parked job still says which queue
 * it came from.
 */
async function runEventJobs(
  admin: Admin,
  kind: string,
  handler: (admin: Admin, job: ClaimedUnlockJob) => Promise<HandlerResult>,
  scope: string,
): Promise<{ claimed: number; results: (HandlerResult & { jobId: string })[] }> {
  const results: (HandlerResult & { jobId: string })[] = [];

  for (let i = 0; i < UNLOCK_BATCH; i += 1) {
    const job = await claimUnlockJob(admin, kind);
    // Nothing available to this runner, or the claim itself failed. Both end
    // the batch; only the second is worth a line in the log, and the claim
    // already wrote it.
    if (job === 'empty' || job === 'unavailable') break;

    // A thrown client is the same fact as a returned error, and it is the one
    // most likely during exactly the blip this retry budget exists for — an
    // undici socket error or a malformed response arrives as an exception, not
    // as `{ error }` (gap G-081).
    //
    // Unguarded it cost more than one job. The throw left this row `running`
    // with its attempt already spent, invisible to every claim until the reaper
    // released it fifteen minutes on — and it propagated out of the loop, so
    // the rest of the batch never ran and the whole tick answered 500.
    let result: HandlerResult;
    try {
      result = await handler(admin, job);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          level: 'error',
          scope,
          jobId: job.id,
          detail: `handler threw: ${detail}`,
        }),
      );
      // Retryable, deliberately: a throw says nothing about whether the work
      // is possible, only that this attempt did not finish. The backoff in
      // settleUnlockJob then spaces the next one (D18).
      result = { status: 'failed', permanent: false, detail: `handler threw: ${detail}` };
    }

    await settleUnlockJob(admin, job, result, kind, scope);

    results.push({ jobId: job.id, ...result });
  }

  return { claimed: results.length, results };
}

/**
 * Claims one unlock job.
 *
 * Two steps rather than one, matching the extraction path above: select a
 * candidate, then update it with `status = 'queued'` still in the predicate.
 * That predicate is the whole lock — a second runner's update matches zero
 * rows, so the same job cannot be handled twice concurrently.
 */
async function claimUnlockJob(
  admin: Admin,
  kind: string,
): Promise<ClaimedUnlockJob | 'empty' | 'unavailable'> {
  // One statement (gap G-082). The status change, the lock and the attempt
  // increment happen together, and `attempts = attempts + 1` is evaluated
  // against the row being locked rather than against a copy read a statement
  // earlier — so two runners cannot both write "the count I saw, plus one".
  //
  // This replaced a SELECT-then-compare-and-swap that was correct only because
  // D18 remembered to restate two conditions on the write. `for update skip
  // locked` makes the same guarantee structural: a second runner steps over a
  // row somebody else is taking instead of racing it, so there is no longer a
  // `raced` outcome to distinguish — an empty result means nothing is
  // available to *this* runner, which is the same instruction either way.
  const { data, error } = await admin.schema('core').rpc('claim_jobs', {
    p_worker_id: `jobs-run:${kind}`,
    p_kind: kind,
    // One at a time. A caller must be able to settle every row it claims, and
    // an invocation killed part-way through a larger batch would strand the
    // rest in `running` with their attempts already spent.
    p_batch_size: 1,
  });

  if (error) {
    // A claim that failed is not a queue that is empty. Reporting it as empty
    // would end the batch silently on exactly the blip the retry budget exists
    // for — the D3 and D5 shape, one layer up.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'claimUnlockJob',
        detail: error.message,
      }),
    );
    return 'unavailable';
  }

  const row = (data ?? [])[0];
  if (!row) return 'empty';

  return {
    id: row.id,
    organization_id: row.organization_id,
    payload: row.payload as ClaimedUnlockJob['payload'],
    // Already incremented by the claim, so this is the attempt now in
    // progress — the same number the old two-step reported.
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    correlation_id: row.correlation_id,
  };
}

/**
 * Says out loud that a job will never be tried again.
 *
 * Gap G-080. Nothing in this repository moves a row out of `dead`: the reaper
 * matches `status = 'running'` only, and the outbox cannot re-enqueue because
 * the job's `dedupe_key` still exists. So the moment a job is parked is the
 * last moment anyone could act on it — and until now that moment produced no
 * distinct signal at all. `last_error` was written to the row, and nothing
 * reads `core.jobs`: no page, no API, no metric.
 *
 * A permanent refusal already logged its reason from the handler. What was
 * missing is the *death* — the difference between "this attempt failed" and
 * "this will not be attempted again", which is the only one worth waking
 * somebody for.
 *
 * One line, at error level, with the fields an alert would filter on. This is
 * not monitoring: nothing ingests it and nothing pages. G-053 and ADM-21 are
 * where that lives. It is the signal being emitted so that when there is
 * something to ingest, there is something to ingest.
 */
/**
 * Records what became of a job.
 *
 * A permanent refusal — wrong organization, wrong project, an invoice that is
 * not actually paid — is parked as `dead` immediately rather than retried five
 * times, because none of those become true by waiting. The reason is written
 * to `last_error` either way, so a refused unlock is visible in the queue
 * instead of vanishing: the runner never reports success it did not achieve.
 */
async function settleUnlockJob(
  admin: Admin,
  job: ClaimedUnlockJob,
  result: HandlerResult,
  kind: string,
  scope: string,
): Promise<void> {
  if (result.status === 'succeeded') {
    await admin
      .schema('core')
      .from('jobs')
      .update({ status: 'succeeded', locked_at: null, locked_by: null, last_error: null })
      .eq('id', job.id);
    return;
  }

  // `job.attempts` is the attempt now in progress: core.claim_jobs increments
  // it inside the statement that takes the lock (G-082).
  const settlement = settlementFor(
    { attemptsMade: job.attempts, maxAttempts: job.max_attempts },
    result.permanent,
    Date.now(),
  );

  if (settlement.status === 'dead') {
    logJobParked(job, kind, result.detail ?? 'no reason recorded');
  }

  const { error } = await admin
    .schema('core')
    .from('jobs')
    .update({
      status: settlement.status,
      last_error: result.detail,
      locked_at: null,
      locked_by: null,
      // Audit finding D18. Without this the row goes back to `queued` carrying
      // the run_at it was enqueued with — still in the past, and still the
      // oldest queued unlock, so the very next turn of the loop above claims
      // it again. Five turns, five attempts, `dead` inside one cron tick and a
      // few hundred milliseconds. A retryable failure is retryable precisely
      // because waiting might help; this is what makes waiting happen.
      ...(settlement.status === 'queued' ? { run_at: settlement.runAt } : {}),
    })
    .eq('id', job.id);

  // The one failure that leaves no trace anywhere else.
  //
  // The retryable results this settles are database read failures, so the blip
  // that failed the read is the blip most likely to fail this write a
  // millisecond later — on the same pool. When it does, the row stays
  // `running` with the attempt already spent, invisible to every claim until
  // the reaper releases it fifteen minutes on. That is recoverable, but it is
  // not the schedule above, and a silent `await` would make it look like one.
  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: `${scope}:settle`,
        jobId: job.id,
        intended: settlement.status,
        detail: error.message,
      }),
    );
  }
}

/**
 * Writes the ai.agent_steps row for one model call and returns the number of
 * steps now recorded, so the caller can keep agent_runs.step_count honest.
 *
 * What goes in `request` is the shape of the call, not a copy of the
 * conversation: the model, effort, schema and message count, plus the system
 * prompt — which is ours and constant. The transcript itself already lives in
 * crm.conversation_messages under RLS, and duplicating customer text into the
 * ai schema would spread the same PII across two owners for no diagnostic gain.
 *
 * `response` holds what the model actually returned, *before* Zod validation.
 * That is deliberate: when validation rejects the output there is no
 * requirement_version to inspect, and this row is the only place the malformed
 * payload survives.
 *
 * A failure to write the trace is logged, never fatal. Losing an audit row is
 * bad; failing an otherwise-successful extraction because the audit row would
 * not insert is worse.
 */
/**
 * Settles a failed extraction, and records it where a human will look.
 *
 * A transient failure is not a failed *proposal*. The job is requeued, the next
 * tick may well succeed, and the reason already lives in `core.jobs.last_error`
 * and `ai.agent_runs.error` — which is what those columns are for. Writing a
 * `failed` version for every bad attempt would fill the owner's view with
 * proposals that a retry then contradicts.
 *
 * When the attempts run out that stops being true. `failed` then states a fact
 * about the conversation — this one will not produce a proposal — rather than
 * about one attempt, and it belongs in crm.requirement_versions where the owner
 * is already reading. Without it, a permanently failed extraction is invisible
 * outside the queue and looks exactly like one nobody has run.
 *
 * Idempotent on `source_job_id`: a reaped-and-retried job cannot write two.
 */
/**
 * Retries until max_attempts, then parks the job as dead.
 *
 * `job.attempts` is the attempt now in progress. Both paths claim through
 * core.claim_jobs since G-082, which increments inside the same statement that
 * takes the lock — so both hand `attemptsMade` the same number and the
 * off-by-one the two conventions used to invite is gone.
 *
 * This path never storms the way the unlock path did (D18): there is no loop
 * here — POST claims exactly one extraction job and every branch after the
 * claim returns — so a requeued row waits for the next cron tick regardless.
 * It gets the same backoff anyway, for two reasons. Two settle paths with two
 * retry policies is how policies drift. And a minute between attempts is not
 * much spacing for the failure this path actually sees — a model provider
 * erroring or rate-limiting — where five tries in five minutes can easily fall
 * entirely inside one incident.
 *
 * "One rule in one place" would overstate it: `core.reap_stalled_jobs` is a
 * third path that returns a row to `queued`, and it consults nothing here. It
 * is left alone deliberately — a stalled worker never made an attempt, so
 * there is nothing to back off from — but it does mean a queued row's `run_at`
 * cannot be read as "the retry rule put it there".
 */
