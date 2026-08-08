import { NextResponse, type NextRequest } from 'next/server';

import { resolveProvider } from '@/lib/ai/router';
import type { AiMessage } from '@/lib/ai/types';
import { createAdminClient } from '@/lib/db/admin';
import { serverEnv } from '@/lib/env';
import { newCorrelationId } from '@/lib/errors';
import { requirementJsonSchema, requirementPayloadSchema } from '@/modules/crm/schema';

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
};

function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

export async function POST(request: NextRequest) {
  const { CRON_SECRET } = serverEnv();
  if (!CRON_SECRET) {
    return NextResponse.json(
      { error: 'job runner disabled: CRON_SECRET is not configured' },
      { status: 503 },
    );
  }

  const presented = request.headers.get('authorization');
  if (presented !== `Bearer ${CRON_SECRET}`) return unauthorized();

  const admin = createAdminClient();
  const correlationId = newCorrelationId();

  // ── claim one job ───────────────────────────────────────────────────────
  const { data: candidate } = await admin
    .schema('core')
    .from('jobs')
    .select('id, organization_id, payload, attempts, max_attempts, correlation_id')
    .eq('kind', JOB_KIND)
    .eq('status', 'queued')
    .lte('run_at', new Date().toISOString())
    .order('priority', { ascending: true })
    .order('run_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!candidate) {
    return NextResponse.json({ claimed: 0, correlationId });
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
    await failJob(admin, job, provider.error.message);
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

  const started = Date.now();
  const response = await provider.data.generateStructured({
    model: agent.default_model,
    system: SYSTEM_PROMPT,
    messages: transcript,
    jsonSchema: requirementJsonSchema(),
    schemaName: 'RequirementPayload',
    effort: agent.default_effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  });

  if (!response.ok) {
    await finishRun(admin, runId, 'failed', response.error.message);
    await failJob(admin, job, response.error.message);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: 'provider error', runId });
  }

  // Never trust the provider's claim of schema conformance (§6.6).
  const validated = requirementPayloadSchema.safeParse(response.data.json);
  if (!validated.success) {
    const detail = 'model output failed schema validation';
    await finishRun(admin, runId, 'failed', detail);
    await failJob(admin, job, detail);
    return NextResponse.json({ claimed: 1, status: 'failed', reason: detail, runId });
  }

  // ── persist as the next version ─────────────────────────────────────────
  const { data: latest } = await admin
    .schema('crm')
    .from('requirement_versions')
    .select('version')
    .eq('conversation_id', conversation.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (latest?.version ?? 0) + 1;

  const { error: insertError } = await admin
    .schema('crm')
    .from('requirement_versions')
    .insert({
      organization_id: job.organization_id,
      conversation_id: conversation.id,
      version: nextVersion,
      source: 'agent',
      status: 'proposed', // the agent is L1: it proposes, a human decides
      payload: validated.data,
      generated_by_run_id: runId,
    });

  if (insertError) {
    await finishRun(admin, runId, 'failed', insertError.message);
    await failJob(admin, job, insertError.message);
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

type Admin = ReturnType<typeof createAdminClient>;

async function finishRun(admin: Admin, runId: string | null, status: string, error: string) {
  if (!runId) return;
  await admin
    .schema('ai')
    .from('agent_runs')
    .update({ status, error, finished_at: new Date().toISOString() })
    .eq('id', runId);
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
