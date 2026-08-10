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
import type { Result } from '@/lib/result';
import { requirementJsonSchema, requirementPayloadSchema } from '@/modules/crm/schema';
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

export async function POST(request: NextRequest) {
  const { CRON_SECRET } = serverEnv();

  const auth = authorizeCronRequest(request.headers.get('authorization'), CRON_SECRET);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const correlationId = newCorrelationId();

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
   * ── milestone unlocks ─────────────────────────────────────────────────
   *
   * Drained before the extraction path below because these are pure database
   * work — no model call, no network — so a batch of them costs milliseconds
   * and holding up the revenue path behind an AI job would be the wrong
   * priority. The batch is bounded, and cron runs every minute, so extraction
   * waits at most one tick behind a burst of unlocks.
   */
  const unlocks = await runUnlockJobs(admin);
  if (unlocks.claimed > 0) {
    return NextResponse.json({
      claimed: unlocks.claimed,
      kind: UNLOCK_JOB_KIND,
      dispatched,
      reaped,
      unlocks: unlocks.results,
      correlationId,
    });
  }

  // ── claim one job ───────────────────────────────────────────────────────
  const { data: candidate } = await admin
    .schema('core')
    .from('jobs')
    .select('id, organization_id, payload, attempts, max_attempts, correlation_id, last_error')
    .eq('kind', JOB_KIND)
    .eq('status', 'queued')
    .lte('run_at', new Date().toISOString())
    .order('priority', { ascending: true })
    .order('run_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!candidate) {
    return NextResponse.json({ claimed: 0, dispatched, reaped, correlationId });
  }

  const job = candidate as JobRow;

  // The status predicate makes the claim atomic: a second runner racing for
  // the same row updates zero rows and backs off.
  const { data: claimed } = await admin
    .schema('core')
    .from('jobs')
    .update({
      status: 'running',
      locked_at: new Date().toISOString(),
      locked_by: `jobs-run:${correlationId}`,
      attempts: job.attempts + 1,
    })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('id')
    .maybeSingle();

  if (!claimed) return NextResponse.json({ claimed: 0, reason: 'raced', correlationId });

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

/**
 * How many unlocks one invocation drains.
 *
 * Bounded because a serverless function has a wall clock. Cron runs every
 * minute, so a larger backlog simply takes a few more ticks; an unbounded loop
 * would instead be killed mid-job and leave rows locked for the reaper.
 */
const UNLOCK_BATCH = 10;

type ClaimedUnlockJob = UnlockJob & { attempts: number; max_attempts: number };

async function runUnlockJobs(
  admin: Admin,
): Promise<{ claimed: number; results: (HandlerResult & { jobId: string })[] }> {
  const results: (HandlerResult & { jobId: string })[] = [];

  for (let i = 0; i < UNLOCK_BATCH; i += 1) {
    const job = await claimUnlockJob(admin);
    // Null means either nothing queued or another runner won this row. Both
    // are answered by asking again: the claim filters on status = 'queued', so
    // a row taken by somebody else cannot come back.
    if (job === 'empty') break;
    if (job === 'raced') continue;

    const result = await handleInvoicePaid(admin, job);
    await settleUnlockJob(admin, job, result);

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
async function claimUnlockJob(admin: Admin): Promise<ClaimedUnlockJob | 'empty' | 'raced'> {
  const { data: candidate } = await admin
    .schema('core')
    .from('jobs')
    .select('id, organization_id, payload, attempts, max_attempts, correlation_id')
    .eq('kind', UNLOCK_JOB_KIND)
    .eq('status', 'queued')
    .lte('run_at', new Date().toISOString())
    .order('priority', { ascending: true })
    .order('run_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!candidate) return 'empty';

  const { data: claimed } = await admin
    .schema('core')
    .from('jobs')
    .update({
      status: 'running',
      locked_at: new Date().toISOString(),
      locked_by: `jobs-run:${UNLOCK_JOB_KIND}`,
      attempts: candidate.attempts + 1,
    })
    .eq('id', candidate.id)
    .eq('status', 'queued')
    .select('id')
    .maybeSingle();

  if (!claimed) return 'raced';

  return {
    id: candidate.id,
    organization_id: candidate.organization_id,
    payload: candidate.payload as ClaimedUnlockJob['payload'],
    attempts: candidate.attempts + 1,
    max_attempts: candidate.max_attempts,
    correlation_id: candidate.correlation_id,
  };
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
): Promise<void> {
  if (result.status === 'succeeded') {
    await admin
      .schema('core')
      .from('jobs')
      .update({ status: 'succeeded', locked_at: null, locked_by: null, last_error: null })
      .eq('id', job.id);
    return;
  }

  const exhausted = result.permanent || job.attempts >= job.max_attempts;

  await admin
    .schema('core')
    .from('jobs')
    .update({
      status: exhausted ? 'dead' : 'queued',
      last_error: result.detail,
      locked_at: null,
      locked_by: null,
    })
    .eq('id', job.id);
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
  const exhausted = job.attempts + 1 >= job.max_attempts;

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

/** Retries until max_attempts, then parks the job as dead. */
async function failJob(admin: Admin, job: JobRow, reason: string) {
  const exhausted = job.attempts + 1 >= job.max_attempts;
  await admin
    .schema('core')
    .from('jobs')
    .update({
      status: exhausted ? 'dead' : 'queued',
      last_error: reason,
      locked_at: null,
      locked_by: null,
    })
    .eq('id', job.id);
}
