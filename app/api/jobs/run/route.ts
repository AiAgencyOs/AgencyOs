import { NextResponse, type NextRequest } from 'next/server';

import { resolveProvider } from '@/lib/ai/router';
import type { AiMessage, StructuredResponse } from '@/lib/ai/types';
import { authorizeCronRequest } from '@/lib/cron-auth';
import { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';
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
import { settlementFor } from '@/lib/jobs/retry';
import type { Result } from '@/lib/result';
import { requirementJsonSchema, requirementPayloadSchema } from '@/modules/crm/schema';
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

const AGENT_KEY = 'requirement_collector';
const JOB_KIND = 'requirement.extract';

const SYSTEM_PROMPT = [
  'You extract structured project requirements from a sales conversation.',
  'Use only what the transcript supports. Do not infer budget or pricing.',
  'If something is unclear or absent, add it to openQuestions rather than guessing.',
  'Respond only with JSON matching the provided schema.',
].join(' ');

type JobRow = {
  id: string;
  organization_id: string;
  payload: { conversationId?: string } | null;
  attempts: number;
  max_attempts: number;
  correlation_id: string | null;
  /** Kept so a recovery path does not overwrite a reason already recorded. */
  last_error: string | null;
};

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

  // ── claim one job ───────────────────────────────────────────────────────
  //
  // The same atomic claim the unlock loop uses (gap G-082): one statement, the
  // attempt increment evaluated against the row being locked, and `for update
  // skip locked` so a second runner steps over a row rather than contending
  // for it. `batch_size: 1` because this path handles exactly one job per
  // invocation, and claiming more would leave rows `running` that nothing in
  // this tick will settle.
  const { data: claimedJobs, error: claimError } = await admin
    .schema('core')
    .rpc('claim_jobs', {
      p_worker_id: `jobs-run:${correlationId}`,
      p_kind: JOB_KIND,
      p_batch_size: 1,
    });

  if (claimError) {
    // Not "nothing queued": a claim that failed says nothing about the queue,
    // and answering `claimed: 0` would report an empty backlog on exactly the
    // blip that caused it.
    console.error(
      JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `claim failed: ${claimError.message}` }),
    );
    return NextResponse.json({ error: 'could not claim a job' }, { status: 503 });
  }

  const claimedRow = (claimedJobs ?? [])[0];
  if (!claimedRow) {
    return NextResponse.json({
      claimed: 0,
      announcements: announcements.results,
      followUpDeliveries: followUpDeliveries.results,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      overdue,
      correlationId,
    });
  }

  // `attempts` is already incremented by the claim, so this row describes the
  // attempt now in progress. failJob is given `attempts` directly rather than
  // `attempts + 1` for that reason.
  const job = claimedRow as JobRow;

  // From here on this row is ours, and every exit below settles it. Recorded so
  // that a *throw* — the exits nobody wrote — settles it too (G-081).
  claimed.job = job;

  const conversationId = job.payload?.conversationId;
  if (!conversationId) {
    await failJob(admin, job, 'job payload has no conversationId');
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'bad payload' });
  }

  // ── agent registry: model and kill switch are data, not code ────────────
  const { data: agent } = await admin
    .schema('ai')
    .from('agents')
    .select('key, enabled, default_model, default_effort, autonomy_level')
    .eq('key', AGENT_KEY)
    .maybeSingle();

  if (!agent) {
    await failJob(admin, job, `agent "${AGENT_KEY}" is not registered`);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'agent missing' });
  }
  if (!agent.enabled) {
    await failJob(admin, job, `agent "${AGENT_KEY}" is disabled`);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'agent disabled' });
  }

  /**
   * ── autonomy, read from the row rather than assumed (G-041) ───────────
   *
   * This column has been selected here since the first day and then ignored,
   * which is worse than not selecting it: the code read as though autonomy
   * were configurable while the behaviour was L1 whatever the row said, so
   * turning an agent down meant a deploy.
   *
   * Checked here for the message and the settled job; `ai.agent_runs` refuses
   * the same thing independently, so a caller that skips this is refused
   * rather than obeyed.
   */
  const autonomy = mayAgentRun(agent.autonomy_level);
  if (!autonomy.allowed) {
    await failJob(admin, job, `agent "${AGENT_KEY}": ${autonomy.reason}`);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'agent autonomy' });
  }

  // ── transcript (hand-scoped by organization) ────────────────────────────
  const { data: conversation } = await admin
    .schema('crm')
    .from('conversations')
    .select('id, organization_id')
    .eq('id', conversationId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (!conversation) {
    await failJob(admin, job, 'conversation not found for this organization');
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'conversation missing' });
  }

  /**
   * ── already produced? ──────────────────────────────────────────────────
   *
   * A job that wrote its version and then died before settling stays `running`
   * until the reaper releases it, and the retry would extract the same
   * transcript a second time. `source_job_id` is unique per organization, so
   * the database would refuse the duplicate — but only after a model call had
   * been paid for and made. Checking first makes the retry free, and makes
   * "this job already produced a proposal" a success rather than a conflict.
   */
  const { data: alreadyProduced } = await admin
    .schema('crm')
    .from('requirement_versions')
    .select('id, version, status')
    .eq('organization_id', job.organization_id)
    .eq('source_job_id', job.id)
    .maybeSingle();

  if (alreadyProduced) {
    /**
     * What this job produced decides how it settles.
     *
     * A `failed` version is only ever written once the attempts are spent, so
     * finding one means the extraction permanently failed and the job's own
     * settlement is what went missing — the process died between the marker and
     * failJob, and the reaper released it. Reporting that as `succeeded`, which
     * is what happened before, closed the job on a lie: the queue said the work
     * was done while the conversation carried a failure nobody was told about.
     *
     * `dead` rather than `queued`, because the attempts really are spent and
     * another run would only rediscover the same failure. Any reason already
     * recorded is kept; only a job that died before writing one gets a new one.
     */
    const failed = alreadyProduced.status === 'failed';

    await admin
      .schema('core')
      .from('jobs')
      .update({
        status: failed ? 'dead' : 'succeeded',
        locked_at: null,
        locked_by: null,
        ...(failed
          ? { last_error: job.last_error ?? 'extraction failed; recorded on the requirement version' }
          : {}),
      })
      .eq('id', job.id);

    return NextResponse.json({
      claimed: 1,
      status: failed ? 'failed' : 'succeeded',
      reason: failed ? 'already failed' : 'already produced',
      versionId: alreadyProduced.id,
      version: alreadyProduced.version,
      correlationId,
    });
  }

  const { data: messages } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('seq, author_type, body')
    .eq('conversation_id', conversation.id)
    .eq('organization_id', job.organization_id)
    .order('seq', { ascending: true });

  const transcript: AiMessage[] = (messages ?? []).map((m) => ({
    role: m.author_type === 'client' ? 'user' : 'assistant',
    content: m.body,
  }));

  /**
   * ── has this transcript already been extracted? ────────────────────────
   *
   * The check above catches a job re-run. This catches a *different* job that
   * would read the same conversation.
   *
   * Jobs are deduped on (conversation, message count), so two messages
   * arriving between ticks queue two of them — one at count 1, one at count 2.
   * Whichever runs first reads the transcript as it stands *now*, which is
   * both messages, and the second job would then extract exactly the same
   * conversation again: two identical proposals for the owner to decide
   * between, and two model calls for one answer.
   *
   * The transcript size is what is duplicated, so that is what is checked, and
   * what requirement_versions_transcript_state_key makes unique. Doing it here
   * — after the transcript is loaded, before the run record is opened — means
   * the redundant job costs two queries rather than a model call.
   *
   * A later message makes this miss and the extraction proceeds, which is
   * right: a longer transcript is a genuinely different thing to read.
   */
  const { data: sameTranscript } = await admin
    .schema('crm')
    .from('requirement_versions')
    .select('id, version, status')
    // Scoped by hand, like every other query behind the service role. A
    // conversation belongs to one organization, but a *version* need not: the
    // insert policy checks the row's own organization_id, not the conversation
    // it points at, so another tenant can attach a row here. Unscoped, one of
    // theirs at the same transcript length suppresses this extraction entirely
    // and its id is returned in the response.
    .eq('organization_id', job.organization_id)
    .eq('conversation_id', conversation.id)
    .eq('source_message_count', transcript.length)
    .maybeSingle();

  if (sameTranscript) {
    await admin.schema('core').from('jobs').update({ status: 'succeeded' }).eq('id', job.id);
    return NextResponse.json({
      claimed: 1,
      status: 'succeeded',
      reason: 'transcript already extracted',
      versionId: sameTranscript.id,
      version: sameTranscript.version,
      messageCount: transcript.length,
      correlationId,
    });
  }

  // ── open the run record before doing any work ───────────────────────────
  const { data: run } = await admin
    .schema('ai')
    .from('agent_runs')
    .insert({
      organization_id: job.organization_id,
      agent_key: AGENT_KEY,
      trigger: `job:${job.id}`,
      subject_type: 'crm.conversation',
      subject_id: conversation.id,
      status: 'running',
      model: agent.default_model,
      input: { conversationId: conversation.id, messageCount: transcript.length },
      correlation_id: job.correlation_id ?? correlationId,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  const runId = run?.id ?? null;

  // ── the model call ──────────────────────────────────────────────────────
  const provider = resolveProvider(agent.default_model);

  if (!provider.ok) {
    // No provider is configured. Record the failure honestly: the run is
    // marked failed with the real reason, and nothing is written to
    // requirement_versions. A queued extraction that cannot run must not look
    // like one that produced an empty result.
    await finishRun(admin, runId, 'failed', provider.error.message);
    await failExtraction(admin, job, conversation.id, runId, provider.error.message, transcript.length);
    return NextResponse.json(
      {
        claimed: 1,
        status: 'failed',
        reason: 'AI_PROVIDER_NOT_CONFIGURED',
        detail: provider.error.message,
        runId,
        correlationId,
      },
      { status: 200 },
    );
  }

  const modelRequest = {
    model: agent.default_model,
    system: SYSTEM_PROMPT,
    messages: transcript,
    jsonSchema: requirementJsonSchema(),
    schemaName: 'RequirementPayload',
    effort: agent.default_effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  };

  const started = Date.now();
  const response = await provider.data.generateStructured(modelRequest);
  const latencyMs = Date.now() - started;

  // The call happened, so it gets a step — whatever its outcome. Written here
  // rather than in the success branch on purpose: a failed model call is the
  // case where the trace is worth the most, and ai.agent_steps has an `error`
  // column precisely for it. Nothing is recorded above, where no provider
  // resolved: no request left the process, so there is no step to record.
  const stepCount = await recordModelCall(admin, {
    organizationId: job.organization_id,
    runId,
    seq: 0,
    providerId: provider.data.id,
    request: modelRequest,
    result: response,
    latencyMs,
  });

  if (!response.ok) {
    await finishRun(admin, runId, 'failed', response.error.message, stepCount);
    await failExtraction(admin, job, conversation.id, runId, response.error.message, transcript.length);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'provider error', runId });
  }

  // Never trust the provider's claim of schema conformance (§6.6).
  const validated = requirementPayloadSchema.safeParse(response.data.json);
  if (!validated.success) {
    const detail = 'model output failed schema validation';
    await finishRun(admin, runId, 'failed', detail, stepCount);
    await failExtraction(admin, job, conversation.id, runId, detail, transcript.length);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: detail, runId });
  }

  /**
   * ── persist as the next version ────────────────────────────────────────
   *
   * The version number is allocated inside the insert, under a lock on the
   * conversation (crm.insert_requirement_version). Reading the highest version
   * and then inserting it is two statements with a gap: two runners working the
   * same conversation both read the same maximum, and the loser fails on
   * `unique (conversation_id, version)` *after* its model call has been paid
   * for, burning an attempt for a collision that cost real money.
   *
   * Same defect the transcript `seq` had, and the same answer.
   */
  const { data: allocated, error: insertError } = await admin
    .schema('crm')
    .rpc('insert_requirement_version', {
      p_organization_id: job.organization_id,
      p_conversation_id: conversation.id,
      p_source: 'agent',
      p_status: 'proposed', // the agent is L1: it proposes, a human decides
      p_payload: validated.data as unknown as Json,
      p_source_job_id: job.id,
      p_source_message_count: transcript.length,
      // Optional, not nullable, in the generated Args: an absent run is the
      // function's own default rather than an explicit null.
      ...(runId ? { p_generated_by_run_id: runId } : {}),
    });

  const nextVersion = (Array.isArray(allocated) ? allocated[0] : allocated)?.version ?? null;

  if (insertError) {
    /**
     * Losing an idempotency race is not a failure.
     *
     * Two indexes say "this proposal already exists", and hitting either means
     * the work this job was queued for is done — by another run of the same job
     * (`source_job`), or by another job that read the same transcript
     * (`transcript_state`). Both checks are made before the model call, so
     * reaching here at all means two runners were inside the same instant.
     *
     * Treating that as a failure was the expensive half of the defect: the job
     * was requeued, one of its attempts was spent, and the extraction it had
     * already paid a model call for was thrown away — to arrive, on retry, at a
     * proposal that was there all along. The proposal exists; the job is done.
     *
     * The model call itself can still be made twice in a genuine race, because
     * both runners check before either writes. Holding a lock across a network
     * call to avoid that would be the wrong trade.
     */
    const raced =
      insertError.code === '23505' &&
      (insertError.message.includes('source_job') ||
        insertError.message.includes('transcript_state'));

    if (raced) {
      await admin
        .schema('core')
        .from('jobs')
        .update({ status: 'succeeded', locked_at: null, locked_by: null })
        .eq('id', job.id);
      await finishRun(admin, runId, 'superseded', 'another run wrote this proposal', stepCount);
      return NextResponse.json({ claimed: 1, status: 'succeeded', reason: 'raced', runId });
    }

    await finishRun(admin, runId, 'failed', insertError.message, stepCount);
    await failExtraction(admin, job, conversation.id, runId, insertError.message, transcript.length);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'persist failed', runId });
  }

  await admin
    .schema('ai')
    .from('agent_runs')
    .update({
      status: 'succeeded',
      output: validated.data,
      input_tokens: response.data.usage.inputTokens,
      output_tokens: response.data.usage.outputTokens,
      cost_minor: response.data.usage.costMinor,
      step_count: stepCount,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId ?? '');

  await admin.schema('core').from('jobs').update({ status: 'succeeded' }).eq('id', job.id);

  return NextResponse.json({
    claimed: 1,
    status: 'succeeded',
    runId,
    version: nextVersion,
    latencyMs: Date.now() - started,
    correlationId,
  });
}

/**
 * GET /api/jobs/run — the scheduler's door onto the same handler.
 *
 * Vercel Cron invokes a path with a GET request and no body; it has no option
 * to send POST. Rather than reshape the runner around that, this forwards to
 * POST verbatim — same authentication, same work, same response — so there is
 * exactly one implementation and the cron path cannot drift from the one the
 * verification scripts exercise.
 *
 * It is not a weaker door. Nothing is checked here; POST performs the identical
 * `Authorization: Bearer <CRON_SECRET>` check on the identical request object,
 * so an unauthenticated GET is refused exactly as an unauthenticated POST is.
 */
export async function GET(request: NextRequest) {
  return POST(request);
}

type Admin = ReturnType<typeof createAdminClient>;

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
function logJobParked(job: { id: string; organization_id: string; attempts: number }, kind: string, reason: string) {
  console.error(
    JSON.stringify({
      level: 'error',
      scope: 'jobs/dead',
      jobId: job.id,
      organizationId: job.organization_id,
      kind,
      attempts: job.attempts,
      detail: reason,
      note: 'parked dead — nothing retries this',
    }),
  );
}

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

async function finishRun(
  admin: Admin,
  runId: string | null,
  status: string,
  error: string,
  stepCount = 0,
) {
  if (!runId) return;
  await admin
    .schema('ai')
    .from('agent_runs')
    .update({ status, error, step_count: stepCount, finished_at: new Date().toISOString() })
    .eq('id', runId);
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
async function recordModelCall(
  admin: Admin,
  args: {
    organizationId: string;
    runId: string | null;
    seq: number;
    providerId: string;
    request: {
      model: string;
      system: string;
      messages: readonly AiMessage[];
      schemaName: string;
      effort: string;
    };
    result: Result<StructuredResponse>;
    latencyMs: number;
  },
): Promise<number> {
  if (!args.runId) return 0;

  const usage = args.result.ok ? args.result.data.usage : null;

  const { error } = await admin
    .schema('ai')
    .from('agent_steps')
    .insert({
      organization_id: args.organizationId,
      run_id: args.runId,
      seq: args.seq,
      kind: 'model_call',
      request: {
        provider: args.providerId,
        model: args.request.model,
        effort: args.request.effort,
        schema: args.request.schemaName,
        system: args.request.system,
        message_count: args.request.messages.length,
      },
      response: args.result.ok
        ? // `json` is `unknown` at the port boundary because a provider's
          // conformance claim is not proof. It is nonetheless the output of
          // JSON.parse, so it is representable as jsonb; the cast narrows to
          // the column's type without asserting anything about its *shape*,
          // which only Zod does, further down.
          { model: args.result.data.model, json: args.result.data.json as Json }
        : null,
      tokens_in: usage?.inputTokens ?? 0,
      tokens_out: usage?.outputTokens ?? 0,
      cost_minor: usage?.costMinor ?? 0,
      latency_ms: args.latencyMs,
      error: args.result.ok ? null : args.result.error.message,
    });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'recordModelCall', detail: error.message }),
    );
    return 0;
  }

  return args.seq + 1;
}

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
async function failExtraction(
  admin: Admin,
  job: JobRow,
  conversationId: string,
  runId: string | null,
  reason: string,
  messageCount: number,
): Promise<void> {
  // `job.attempts` is the attempt now in progress: the atomic claim
  // incremented it (G-082), where the old two-step handed back the pre-claim
  // row and every caller had to add one. Adding one here now would spend the
  // budget an attempt early and write the `failed` marker before it was true.
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    const { error } = await admin
      .schema('crm')
      .rpc('insert_requirement_version', {
        p_organization_id: job.organization_id,
        p_conversation_id: conversationId,
        p_source: 'agent',
        p_status: 'failed',
        p_payload: {} as unknown as Json,
        p_source_job_id: job.id,
        p_source_message_count: messageCount,
        ...(runId ? { p_generated_by_run_id: runId } : {}),
      });

    // 23505 means another run of this job already recorded it. Anything else is
    // logged and swallowed: losing the marker is bad, but refusing to settle a
    // job because its marker would not insert is worse — the same trade
    // recordModelCall makes about the trace.
    if (error && error.code !== '23505') {
      console.error(
        JSON.stringify({ level: 'error', scope: 'failExtraction', detail: error.message }),
      );
    }
  }

  await failJob(admin, job, reason);
}

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
async function failJob(admin: Admin, job: JobRow, reason: string) {
  // Every failure reaching here is retryable until the budget runs out; this
  // path has no permanent-refusal concept of its own.
  const settlement = settlementFor(
    { attemptsMade: job.attempts, maxAttempts: job.max_attempts },
    false,
    Date.now(),
  );

  if (settlement.status === 'dead') {
    logJobParked(job, JOB_KIND, reason);
  }

  const { error } = await admin
    .schema('core')
    .from('jobs')
    .update({
      status: settlement.status,
      last_error: reason,
      locked_at: null,
      locked_by: null,
      ...(settlement.status === 'queued' ? { run_at: settlement.runAt } : {}),
    })
    .eq('id', job.id);

  // Same reasoning as settleUnlockJob: a settle that does not land leaves the
  // row `running` with its attempt spent, waiting on the reaper rather than on
  // the schedule this just computed.
  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'failJob',
        jobId: job.id,
        intended: settlement.status,
        detail: error.message,
      }),
    );
  }
}
