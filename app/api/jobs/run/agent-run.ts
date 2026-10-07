/**
 * The parts of running an agent that are the same whichever agent it is.
 *
 * Until now there was one agent and the runner was written around it: the key,
 * the job kind, the system prompt and the output schema were four module-level
 * constants, so `requirement_collector` was not *an* agent the runner could
 * dispatch to — it was the only shape the runner had. Twelve more agents were
 * defined, installed and disabled, and enabling any of them would have changed
 * nothing, because nothing could have sent them work.
 *
 * What is generic lives here; what differs per agent lives in `workflows.ts`.
 * The line between them is the one thing worth getting right: **identity,
 * authorization and accounting are generic; the subject and the output are
 * not.** An agent that could bring its own autonomy check or its own cost
 * accounting would be an agent that could skip them.
 */

import { parseModelJson } from '@/lib/ai/model-json';
import { AgentPolicyRefusal, loadAgentPolicy, recordAgentPolicyRefusal } from '@/lib/ai/agent-policy';
import { routedCandidatesFor } from '@/lib/ai/agent-routing';
import { costMinorFor, loadRouting, priceKey, requiredCapabilitiesFor, type LoadedRouting } from '@/lib/ai/routing-config';
import { planRoute, type RoutePlan } from '@/lib/ai/route-plan';
import { categoryForAgent } from '@/lib/ai/model-choice';
import { runWithFallback, type Candidate } from '@/lib/ai/fallback';
import { decideProjectAction, projectIdOf } from '@/lib/ai/policy-decision';
import { resolveProvider } from '@/lib/ai/router';
import { checkRunGates, raiseAlert, refuseIfOverBudget, type AgentBudgetRefusal, type AgentsPaused, type JobCancelled } from '@/lib/ai/run-gates';
import type { AiMessage, AiToolSpec, AiUsage, StructuredResponse, ToolCallResponse } from '@/lib/ai/types';
import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';
import { attemptBudgetFor, settlementFor } from '@/lib/jobs/retry';
import { recordRunUsageCost } from './usage-cost';
import { err, type Result } from '@/lib/result';

export type Admin = ReturnType<typeof createAdminClient>;

export type JobRow = {
  id: string;
  kind: string;
  organization_id: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  correlation_id: string | null;
  last_error: string | null;
};

/** The registry row, read rather than assumed — the kill switch is data. */
export type AgentRow = {
  key: string;
  enabled: boolean;
  default_model: string;
  default_effort: string;
  autonomy_level: string;
  /** ADM-61 classes the owner allows this agent (SCR-063). Empty = every class. */
  allowed_work_classes: string[];
};

/** Everything a workflow is handed once the generic gates have passed. */
export type AgentContext = {
  admin: Admin;
  job: JobRow;
  agent: AgentRow;
  correlationId: string;
  /**
   * ADM-61's classification of this task, carried from the workflow so the run
   * row can record it. The database guard refuses a run that does not say —
   * the runner always sets it, so an absent one means something bypassed the
   * runner.
   */
  workClass: string;
};

export const settledSucceeded = {
  status: 'succeeded',
  locked_at: null,
  locked_by: null,
  last_error: null,
} as const;

/**
 * Opens the run record before any work happens.
 *
 * Before, not after: a run that is created only on success is a run that
 * cannot describe a failure, and `ai.agent_runs.error` exists because most of
 * what this system has learned about its agents came from the 33 that failed.
 */
export async function openRun(
  ctx: AgentContext,
  subject: { type: string; id: string; input: Json },
): Promise<string | null> {
  /**
   * Decision 3 (2026-09-29): before an agent acts on a project, the
   * assignment is asked. Every project workflow names `projectId` in the
   * input it opens with, so this is the one generic place the rule can sit
   * — the workflow has read its subject and has not yet called the model.
   * A refusal is still a run row (status `failed`, the reason as its error,
   * so the agent's Failures list and the run explorer both show it), plus
   * the refusal record and its audit entry, and then a throw that
   * `runOneAgentJob` catches: `openRun` returns an id, and a workflow handed
   * one would carry on.
   */
  const projectId = projectIdOf(subject.input);
  const verdict = projectId
    ? decideProjectAction({
        agentKey: ctx.agent.key,
        projectId,
        assignedProjectIds: (await loadAgentPolicy(ctx.admin, ctx.job.organization_id, ctx.agent.key)).assignedProjectIds,
      })
    : ({ allowed: true } as const);

  const { data } = await ctx.admin
    .schema('ai')
    .from('agent_runs')
    .insert({
      organization_id: ctx.job.organization_id,
      agent_key: ctx.agent.key,
      trigger: `job:${ctx.job.id}`,
      subject_type: subject.type,
      subject_id: subject.id,
      status: verdict.allowed ? 'running' : 'failed',
      work_class: ctx.workClass,
      model: ctx.agent.default_model,
      input: subject.input,
      correlation_id: ctx.job.correlation_id ?? ctx.correlationId,
      started_at: new Date().toISOString(),
      ...(verdict.allowed ? {} : { error: verdict.reason, finished_at: new Date().toISOString() }),
    })
    .select('id')
    .single();

  const runId = data?.id ?? null;

  if (!verdict.allowed) {
    await recordAgentPolicyRefusal(ctx.admin, {
      organizationId: ctx.job.organization_id,
      agentKey: ctx.agent.key,
      kind: verdict.kind,
      reason: verdict.reason,
      runId,
      projectId,
    });
    throw new AgentPolicyRefusal({ kind: verdict.kind, agentKey: ctx.agent.key, reason: verdict.reason, runId });
  }

  return runId;
}

/**
 * A job the policy refused is parked dead at once, not retried: nothing
 * about a retry changes the owner's assignments, and five attempts at the
 * same refusal would be five refusal rows saying the same thing.
 */
export async function parkRefusedJob(admin: Admin, job: JobRow, refusal: AgentPolicyRefusal): Promise<void> {
  logJobParked(job, job.kind, refusal.message);
  const { error } = await admin
    .schema('core')
    .from('jobs')
    .update({ status: 'dead', last_error: `refused by agent policy (${refusal.kind}): ${refusal.message}`, locked_at: null, locked_by: null })
    .eq('id', job.id);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'parkRefusedJob', jobId: job.id, detail: error.message }));
  }
}

/**
 * A job whose cancel flag the runner honoured between steps — SCR-065/066.
 * `core.settle_cancelled_job` moves job and run to cancelled and audits it in
 * one transaction; the runner only reports what it did.
 */
export async function settleCancelledJob(admin: Admin, cancelled: JobCancelled): Promise<void> {
  const { error } = await admin.schema('core').rpc('settle_cancelled_job', {
    p_job_id: cancelled.jobId,
    ...(cancelled.runId ? { p_run_id: cancelled.runId } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'settleCancelledJob', jobId: cancelled.jobId, detail: error.message }));
  }
}

/**
 * The owner paused agents while this job ran — SCR-068. The job goes back to
 * the queue (unclaimable until the switch is released; the attempt it spent
 * stays spent), and the run closes as failed with the reason, because a
 * transcript cannot be resumed from the middle.
 */
export async function requeuePausedJob(admin: Admin, job: JobRow, paused: AgentsPaused): Promise<void> {
  await finishRun(admin, paused.runId, 'failed', paused.message);
  const { error } = await admin
    .schema('core')
    .from('jobs')
    .update({ status: 'queued', last_error: paused.message, locked_at: null, locked_by: null, run_at: new Date(Date.now() + 5 * 60_000).toISOString() })
    .eq('id', job.id);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'requeuePausedJob', jobId: job.id, detail: error.message }));
  }
}

/**
 * A provider over its monthly budget — SCR-064. Parked dead at once, like a
 * policy refusal: a retry in a minute meets the same cap. The run closes as
 * `budget_exceeded`, the status ai.agent_runs has carried for exactly this.
 */
export async function parkBudgetRefusedJob(admin: Admin, job: JobRow, refusal: AgentBudgetRefusal): Promise<void> {
  logJobParked(job, job.kind, refusal.message);
  await finishRun(admin, refusal.runId, 'budget_exceeded', refusal.message);
  const { error } = await admin
    .schema('core')
    .from('jobs')
    .update({ status: 'dead', last_error: `refused by provider budget: ${refusal.message}`, locked_at: null, locked_by: null })
    .eq('id', job.id);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'parkBudgetRefusedJob', jobId: job.id, detail: error.message }));
  }
}

export async function finishRun(
  admin: Admin,
  runId: string | null,
  status: string,
  error: string,
  stepCount = 0,
  /**
   * What the model call already cost. A call whose output was refused by the
   * schema was still billed; recording it as 0 tokens made the failures the
   * cheapest-looking rows in the ledger (cost_minor 0 means "no price", not
   * "free"), and hid the retries that were burning money.
   */
  usage?: { inputTokens: number; outputTokens: number; costMinor: number },
): Promise<void> {
  if (!runId) return;
  await admin
    .schema('ai')
    .from('agent_runs')
    .update({
      status,
      error,
      step_count: stepCount,
      finished_at: new Date().toISOString(),
      ...(usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_minor: usage.costMinor } : {}),
    })
    .eq('id', runId);
}

export async function succeedRun(
  admin: Admin,
  runId: string | null,
  output: Json,
  usage: { inputTokens: number; outputTokens: number; costMinor: number },
  stepCount: number,
): Promise<void> {
  if (!runId) return;
  await admin
    .schema('ai')
    .from('agent_runs')
    .update({
      status: 'succeeded',
      output,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_minor: usage.costMinor,
      step_count: stepCount,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

/**
 * Writes the ai.agent_steps row for one model call and returns the number of
 * steps now recorded, so the caller can keep agent_runs.step_count honest.
 *
 * What goes in `request` is the shape of the call, not a copy of the
 * conversation: the model, effort, schema and message count, plus the system
 * prompt — which is ours. The transcript itself already lives under RLS in the
 * module that owns it, and duplicating customer text into the `ai` schema
 * would spread the same PII across two owners for no diagnostic gain.
 *
 * `response` holds what the model actually returned, *before* validation. That
 * is deliberate: when validation rejects the output there is nothing else to
 * inspect, and this row is the only place the malformed payload survives.
 *
 * A failure to write the trace is logged, never fatal.
 */
export async function recordModelCall(
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
    /** Set only on a fallback attempt: which attempt this was and the model whose failure led to it. */
    routing?: { attempt: number; fallbackOf: string | null };
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
        ...(args.routing ? { routing: args.routing } : {}),
      },
      response: args.result.ok
        ? // `json` is `unknown` at the port boundary because a provider's
          // conformance claim is not proof. It is nonetheless the output of
          // JSON.parse, so it is representable as jsonb; the cast narrows to
          // the column's type without asserting anything about its *shape*,
          // which only the schema does, further down.
          { model: args.result.data.model, json: args.result.data.json as Json }
        : null,
      tokens_in: usage?.inputTokens ?? 0,
      tokens_out: usage?.outputTokens ?? 0,
      cost_minor: usage?.costMinor ?? 0,
      latency_ms: args.latencyMs,
      error: args.result.ok ? null : args.result.error.message,
    });

  // The project's cost record, whatever became of the trace row: it never throws (see usage-cost.ts).
  await recordRunUsageCost(admin, { runId: args.runId, providerId: args.providerId, model: args.request.model, usage });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'recordModelCall', detail: error.message }),
    );
    return 0;
  }

  return args.seq + 1;
}

export function logJobParked(
  job: { id: string; organization_id: string; attempts: number },
  kind: string,
  reason: string,
): void {
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

export async function failJob(admin: Admin, job: JobRow, reason: string): Promise<void> {
  // Every failure reaching here is retryable until the budget runs out; this
  // path has no permanent-refusal concept of its own.
  const settlement = settlementFor(
    { attemptsMade: job.attempts, maxAttempts: attemptBudgetFor(reason, job.max_attempts) },
    false,
    Date.now(),
  );

  if (settlement.status === 'dead') {
    logJobParked(job, job.kind, reason);
    // SCR-067: work the queue gave up on is a situation a person acknowledges.
    await raiseAlert(admin, {
      organizationId: job.organization_id,
      source: 'jobs',
      severity: 'critical',
      summary: `Job ${job.kind} died after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}: ${reason.slice(0, 300)}`,
      fingerprint: `dead-job:${job.kind}`,
    });
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

  // A settle that does not land leaves the row `running` with its attempt
  // spent, waiting on the reaper rather than on the schedule just computed.
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

/**
 * Resolves the provider, makes the one structured call, and records the step.
 *
 * The step is written whatever the outcome — a failed model call is the case
 * where the trace is worth the most, and `ai.agent_steps.error` exists
 * precisely for it. Nothing is recorded when no provider resolved: no request
 * left the process, so there is no step to record.
 */
export async function callModel(
  ctx: AgentContext,
  spec: { systemPrompt: string; schemaName: string; jsonSchema: () => Record<string, unknown> },
  messages: readonly AiMessage[],
  runId: string | null,
): Promise<
  | { ok: false; kind: 'no_provider'; detail: string; stepCount: 0 }
  | { ok: false; kind: 'provider_error'; detail: string; stepCount: number }
  | {
      ok: true;
      json: unknown;
      usage: { inputTokens: number; outputTokens: number; costMinor: number };
      stepCount: number;
    }
> {
  // SCR-064: an owner's (agent, category) override, then the category policy,
  // then the work class's fallback chain, are asked before the row's default.
  // Failure-time routing: if the model first chosen cannot serve the call
  // (rate limit, 5xx, timeout, rejected key, missing model) the next candidate
  // is tried — see fallback.ts for exactly when, and when never.
  const plan = await modelPlanFor(ctx, { needsTools: false });
  if (!plan.ok) {
    await recordDecision(ctx, plan.routing, runId, { outcome: 'blocked', attempts: [], final: null, blockedReason: plan.detail });
    return { ok: false, kind: 'no_provider', detail: plan.detail, stepCount: 0 };
  }

  // Between steps, before the call: a cancel flag and the agents_paused switch
  // (SCR-065/068). Each throws; the tick catches exactly those classes and
  // settles the job. The provider budget is asked per attempt, below, because
  // a fallback may be a different provider with a different cap.
  await checkRunGates(ctx.admin, { jobId: ctx.job.id, organizationId: ctx.job.organization_id, runId });

  let seq = 0;
  const outcome = await runWithFallback<StructuredResponse>({
    candidates: plan.candidates,
    sameVendorOnly: sameVendorOnly(ctx),
    attempt: async (candidate, info) => {
      await refuseIfOverBudget(ctx.admin, { organizationId: ctx.job.organization_id, agentKey: ctx.agent.key, provider: candidate.providerId, runId, model: candidate.model });
      const provider = await resolveProvider(candidate.model, { providerId: candidate.providerId });
      if (!provider.ok) return { ok: false, error: provider.error };

      const request = {
        model: candidate.model,
        system: spec.systemPrompt,
        messages: [...messages],
        jsonSchema: spec.jsonSchema(),
        schemaName: spec.schemaName,
        effort: ctx.agent.default_effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
      };

      const started = Date.now();
      const raw = await provider.data.generateStructured(request);
      const latencyMs = Date.now() - started;
      // Cost only from a price the Admin recorded for this model; an adapter reports 0 and nothing is ever estimated.
      const response: Result<StructuredResponse> = raw.ok
        ? { ok: true, data: { ...raw.data, usage: { ...raw.data.usage, costMinor: costMinorFor(plan.routing?.loaded.prices.get(priceKey(candidate.providerId, candidate.model)), raw.data.usage) || raw.data.usage.costMinor } } }
        : raw;

      seq = await recordModelCall(ctx.admin, {
        organizationId: ctx.job.organization_id,
        runId,
        seq,
        providerId: candidate.providerId,
        request,
        result: response,
        latencyMs,
        routing: info.index > 0 ? { attempt: info.index, fallbackOf: info.fallbackOf } : undefined,
      });
      return response;
    },
  });

  if (outcome.exhausted) await alertChainExhausted(ctx, outcome.attempts);

  await recordDecision(ctx, plan.routing, runId, {
    outcome: outcome.result.ok ? 'succeeded' : outcome.exhausted ? 'exhausted' : 'failed',
    attempts: outcome.attempts,
    final: outcome.final,
  });

  if (!outcome.result.ok) {
    return { ok: false, kind: 'provider_error', detail: outcome.result.error.message, stepCount: seq };
  }

  return { ok: true, json: outcome.result.data.json, usage: outcome.result.data.usage, stepCount: seq };
}

/**
 * The ordered models a run may use: the owner's routing (override → policy →
 * work-class chain), each one a registered provider serves, then the agent's
 * own default last. A tool-using run keeps only providers that can call tools.
 * The list is empty only when nothing is servable, and then the first reason
 * is the one reported — the same `no_provider` the runner always gave.
 */
async function modelPlanFor(
  ctx: AgentContext,
  options: { needsTools: boolean },
): Promise<{ ok: true; candidates: Candidate[]; routing: RoutingContext | null } | { ok: false; detail: string; routing: RoutingContext | null }> {
  // The routing configuration (mode, assignment, provider and model registry, the Admin's preferences). If it cannot be read the
  // routing this runner always had is used, rather than failing a job over a table that was unreadable for a moment.
  const loaded = await loadRouting(ctx.admin, {
    organizationId: ctx.job.organization_id,
    agentKey: ctx.agent.key,
    agentDefault: ctx.agent.default_model,
    workClass: ctx.workClass,
  });
  if (!loaded) return legacyModelPlan(ctx, options);

  const plan = planRoute({ ...loaded.input, needsTools: options.needsTools, requiredCapabilities: requiredCapabilitiesFor(loaded.category, loaded.profileCapabilities) });
  const routing: RoutingContext = { plan, loaded };
  if (plan.blocked) return { ok: false, detail: plan.blocked.reason, routing };

  const candidates: Candidate[] = [];
  let firstReason: string | null = null;
  for (const c of plan.candidates) {
    // The plan already chose the provider; the call goes to exactly that one (a MANUAL assignment must never drift to another).
    const provider = await resolveProvider(c.model, { providerId: c.providerId });
    if (!provider.ok) {
      firstReason ??= provider.error.message;
      continue;
    }
    if (options.needsTools && !provider.data.generateWithTools) {
      firstReason ??= `${provider.data.id} does not support tool calling.`;
      continue;
    }
    candidates.push({ model: c.model, providerId: c.providerId });
  }

  if (candidates.length === 0) return { ok: false, detail: firstReason ?? 'No AI provider is configured.', routing };
  return { ok: true, candidates, routing };
}

/** What a run knows about how it was routed, kept for the decision record and for pricing. */
type RoutingContext = { plan: RoutePlan; loaded: LoadedRouting };

/** The routing this runner had before the Provider Manager: owner preferences, then the agent's default, each served by a registered provider. */
async function legacyModelPlan(
  ctx: AgentContext,
  options: { needsTools: boolean },
): Promise<{ ok: true; candidates: Candidate[]; routing: null } | { ok: false; detail: string; routing: null }> {
  const routed = await routedCandidatesFor(ctx.admin, ctx.job.organization_id, ctx.agent.key, ctx.workClass);
  const models = routed.includes(ctx.agent.default_model) ? routed : [...routed, ctx.agent.default_model];

  const candidates: Candidate[] = [];
  let firstReason: string | null = null;
  for (const model of models) {
    const provider = await resolveProvider(model);
    if (!provider.ok) {
      firstReason ??= provider.error.message;
      continue;
    }
    if (options.needsTools && !provider.data.generateWithTools) {
      firstReason ??= `${provider.data.id} does not support tool calling.`;
      continue;
    }
    candidates.push({ model, providerId: provider.data.id });
  }

  if (candidates.length === 0) return { ok: false, detail: firstReason ?? 'No AI provider is configured.', routing: null };
  return { ok: true, candidates, routing: null };
}

/**
 * Writes the routing decision - why this provider and model, in which mode and configuration version, what was excluded, each attempt,
 * whether a fallback served it, the outcome - and stamps the run with what ACTUALLY ran. Best effort: a decision that cannot be written
 * is logged and never fails the run.
 */
// The function has no argument defaults, and PostgREST resolves it by the keys present: an omitted key (undefined) is "no such function".
const nullable = (value: string | null | undefined): string => (value ?? null) as unknown as string;

async function recordDecision(
  ctx: AgentContext,
  routing: RoutingContext | null,
  runId: string | null,
  args: {
    outcome: 'succeeded' | 'failed' | 'blocked' | 'exhausted';
    attempts: readonly { model: string; providerId: string; ok: boolean; error: string | null; fallbackOf: string | null }[];
    final: Candidate | null;
    blockedReason?: string;
  },
): Promise<void> {
  if (!routing) return;
  const { plan, loaded } = routing;
  const source = args.final ? plan.candidates.find((c) => c.model === args.final?.model && c.providerId === args.final?.providerId)?.source ?? null : null;
  const first = plan.candidates[0];
  const fallbackUsed = args.attempts.length > 1 || Boolean(args.final && first && (args.final.model !== first.model || args.final.providerId !== first.providerId));
  try {
    const { error } = await ctx.admin.schema('ai').rpc('record_routing_decision', {
      p_organization_id: ctx.job.organization_id,
      p_job_id: ctx.job.id,
      p_run_id: nullable(runId),
      p_agent_key: ctx.agent.key,
      p_work_class: ctx.workClass,
      p_category: nullable(loaded.category),
      p_mode: plan.mode,
      p_config_version: plan.configVersion,
      p_plan: { candidates: plan.candidates, considered: plan.considered, warnings: plan.warnings, blocked: plan.blocked } as unknown as Json,
      p_attempts: args.attempts as unknown as Json,
      p_outcome: args.outcome,
      p_provider_id: nullable(args.final?.providerId),
      p_model_id: nullable(args.final?.model),
      p_selection_source: nullable(source),
      p_fallback_used: fallbackUsed,
      p_blocked_reason: nullable(args.blockedReason),
    });
    if (error) console.error(JSON.stringify({ level: 'error', scope: 'recordDecision', detail: error.message }));
  } catch (cause) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordDecision', detail: cause instanceof Error ? cause.message : String(cause) }));
  }
  // MANUAL mode never substitutes silently, so a failure there is surfaced to the Admin rather than left in a job's last_error.
  if (plan.mode === 'manual' && (args.outcome === 'blocked' || args.outcome === 'failed' || args.outcome === 'exhausted')) {
    await raiseAlert(ctx.admin, {
      organizationId: ctx.job.organization_id,
      source: 'router',
      severity: 'warning',
      summary: `${ctx.agent.key} (${ctx.job.kind}) could not run on its manual assignment: ${(args.blockedReason ?? args.attempts.at(-1)?.error ?? 'the provider was unavailable').slice(0, 300)} Nothing else was substituted.`,
      fingerprint: `router-manual:${ctx.agent.key}`,
    });
  }
}

/**
 * Money-bearing work switches vendor only by the owner's decision, never the
 * router's: finance and upsell, and every quotation job (which prices work the
 * owner then approves). For these the next candidate must be the same vendor.
 */
function sameVendorOnly(ctx: AgentContext): boolean {
  return categoryForAgent(ctx.agent.key) === 'money' || ctx.job.kind.startsWith('quotation.');
}

async function alertChainExhausted(
  ctx: AgentContext,
  attempts: readonly { model: string; error: string | null }[],
): Promise<void> {
  await raiseAlert(ctx.admin, {
    organizationId: ctx.job.organization_id,
    source: 'router',
    severity: 'warning',
    summary: `Every model for ${ctx.agent.key} (${ctx.job.kind}) was unavailable: ${attempts
      .map((a) => `${a.model} — ${(a.error ?? '').slice(0, 80)}`)
      .join('; ')}`.slice(0, 480),
    fingerprint: `router-exhausted:${ctx.agent.key}`,
  });
}

/**
 * Writes the ai.agent_steps row for one TOOL execution — the `tool_call` kind
 * the CHECK constraint has admitted since G-125 and nothing had used, because
 * nothing dispatched a tool. Mirrors `recordModelCall`'s shape deliberately:
 * one function per `kind`, so a reader of `ai.agent_steps` finds the same
 * columns meaning the same thing whichever kind a row is.
 *
 * `request` carries the tool's NAME and its argument shape, not the argument
 * VALUES: an argument can be a lead id, a conversation id, a scope — nothing
 * secret, but this table is read on an admin screen and the discipline
 * `recordModelCall` already keeps (system prompt yes, transcript no) is the
 * same discipline applied here.
 */
async function recordToolCall(
  admin: Admin,
  args: {
    organizationId: string;
    runId: string | null;
    seq: number;
    toolName: string;
    input: unknown;
    result: Result<string>;
    latencyMs: number;
  },
): Promise<number> {
  if (!args.runId) return args.seq;

  const { error } = await admin
    .schema('ai')
    .from('agent_steps')
    .insert({
      organization_id: args.organizationId,
      run_id: args.runId,
      seq: args.seq,
      kind: 'tool_call',
      // SCR-065: the arguments the model gave and the result the tool
      // answered, bounded so a runaway payload cannot fill the trace. Ids,
      // scopes and short text — what the run page needs to say what was
      // asked, and what came back.
      request: { tool: args.toolName, input: boundedJson(args.input) },
      response: args.result.ok ? { result: args.result.data.slice(0, 4_000) } : null,
      tokens_in: 0,
      tokens_out: 0,
      cost_minor: 0,
      latency_ms: args.latencyMs,
      error: args.result.ok ? null : args.result.error.message,
    });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordToolCall', detail: error.message }));
    return args.seq;
  }

  return args.seq + 1;
}

/** A tool loop cannot run forever on a model that keeps asking for more. */
const DEFAULT_MAX_TOOL_ROUNDS = 4;
/** No workflow may ask for more than this, whatever it says: the bound exists so a stuck model cannot run up a bill. */
const HARD_MAX_TOOL_ROUNDS = 12;

/** The recorded copy of a tool's arguments — at most 4 KB of JSON, never a throw. */
function boundedJson(value: unknown): Json {
  try {
    const text = JSON.stringify(value ?? null);
    if (text.length <= 4_000) return JSON.parse(text) as Json;
    return { truncated: true, preview: text.slice(0, 4_000) };
  } catch {
    return { unrecordable: true };
  }
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costMinor: a.costMinor + b.costMinor,
  };
}

/**
 * `callModel`'s sibling for a call the model may answer with a tool request
 * instead of a final answer — G-187, ADM-99.
 *
 * **The authorization boundary is not re-decided here.** `tools` is built by
 * the caller from `dispatchableToolsFor`, which already intersects what the
 * agent is bound to with what ADM-99 dispatches; this function's job is to
 * run the loop, not to widen or narrow who gets offered what.
 *
 * **`dispatch` executes an authorized call and nothing else.** It is handed
 * in rather than imported, so this file — which is generic across every
 * agent — never comes to depend on `tool-dispatch.ts`, which is not: the
 * dependency runs the other way, exactly as `workflows.ts` already depends on
 * `agent-run.ts` and not back.
 *
 * **The final answer is parsed as JSON, the same contract `callModel`
 * gives.** Anthropic's tool-use turns do not carry a forced JSON Schema
 * alongside `tools` the way a schema-only call does, so the system prompt
 * itself must ask for the shape — every prompt passed here already does,
 * because it is the same prompt a non-tool call would have used. A model that
 * ignores the instruction fails exactly where `generateStructured` would: at
 * `JSON.parse`, reported as a provider error rather than accepted as text.
 *
 * **Bounded**, because a model that keeps asking for tools is indistinguishable
 * from one that never intends to answer, and an unbounded loop turns a stuck
 * agent into an unbounded bill.
 */
export async function callModelWithTools(
  ctx: AgentContext,
  spec: { systemPrompt: string; schemaName: string; jsonSchema?: () => Record<string, unknown>; maxToolRounds?: number },
  initialMessages: readonly AiMessage[],
  tools: readonly AiToolSpec[],
  runId: string | null,
  dispatch: (call: { name: string; input: unknown }) => Promise<Result<string>>,
): Promise<
  | { ok: false; kind: 'no_provider'; detail: string; stepCount: number }
  | { ok: false; kind: 'provider_error'; detail: string; stepCount: number }
  | { ok: false; kind: 'tool_limit_exceeded'; detail: string; stepCount: number }
  | {
      ok: true;
      json: unknown;
      usage: { inputTokens: number; outputTokens: number; costMinor: number };
      stepCount: number;
    }
> {
  // Providers that cannot call tools are not candidates (stated in the reason
  // when none can, rather than silently dropping to a structured call).
  // Four rounds is right for a read-and-answer workflow. A workflow that legitimately reads, drafts, checks and submits (the acquisition
  // agents) names its own bound, and no bound can exceed the hard one.
  const MAX_TOOL_ROUNDS = Math.min(Math.max(spec.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS, 1), HARD_MAX_TOOL_ROUNDS);
  const plan = await modelPlanFor(ctx, { needsTools: true });
  if (!plan.ok) {
    await recordDecision(ctx, plan.routing, runId, { outcome: 'blocked', attempts: [], final: null, blockedReason: plan.detail });
    return { ok: false, kind: 'no_provider', detail: plan.detail, stepCount: 0 };
  }
  let active: readonly Candidate[] = plan.candidates;

  const messages: AiMessage[] = [...initialMessages];
  let seq = 0;
  let usage: AiUsage = { inputTokens: 0, outputTokens: 0, costMinor: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    // Between steps, before each model turn: the cancel flag and the pause
    // switch (SCR-065/068). The provider budget is asked per attempt.
    await checkRunGates(ctx.admin, { jobId: ctx.job.id, organizationId: ctx.job.organization_id, runId });

    // Only the FIRST turn may change model. After it, tool results exist that
    // the issuing model must see answered, so later turns are pinned to the
    // model that served turn one (and fall back to nothing).
    const outcome = await runWithFallback<ToolCallResponse>({
      candidates: active,
      sameVendorOnly: sameVendorOnly(ctx),
      canSwitch: round === 0,
      attempt: async (candidate, info) => {
        await refuseIfOverBudget(ctx.admin, { organizationId: ctx.job.organization_id, agentKey: ctx.agent.key, provider: candidate.providerId, runId, model: candidate.model });
        const provider = await resolveProvider(candidate.model, { providerId: candidate.providerId });
        if (!provider.ok) return { ok: false, error: provider.error };
        if (!provider.data.generateWithTools) return err('PROVIDER_ERROR', `${provider.data.id} does not support tool calling.`);

        const request = {
          model: candidate.model,
          system: spec.systemPrompt,
          messages,
          tools,
          ...(spec.jsonSchema ? { jsonSchema: spec.jsonSchema() } : {}),
          effort: ctx.agent.default_effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
        };

        const started = Date.now();
        const rawAttempt = await provider.data.generateWithTools(request);
        const latencyMs = Date.now() - started;
        // Cost only from a price the Admin recorded for this model; an adapter reports 0 and nothing is ever estimated.
        const attempted = rawAttempt.ok
          ? { ...rawAttempt, data: { ...rawAttempt.data, usage: { ...rawAttempt.data.usage, costMinor: costMinorFor(plan.routing?.loaded.prices.get(priceKey(candidate.providerId, candidate.model)), rawAttempt.data.usage) || rawAttempt.data.usage.costMinor } } }
          : rawAttempt;

        seq = await recordModelCall(ctx.admin, {
          organizationId: ctx.job.organization_id,
          runId,
          seq,
          providerId: candidate.providerId,
          request: {
            model: request.model,
            system: request.system,
            messages: request.messages,
            schemaName: spec.schemaName,
            effort: String(request.effort ?? ''),
          },
          // Adapted into `generateStructured`'s response shape so ONE recorder
          // writes every model turn a run makes, tool-using or not: a
          // `tool_calls` turn's "json" is the calls the model asked for, which is
          // exactly what a reader of `ai.agent_steps` wants to see it did.
          result: attempted.ok
            ? {
                ok: true,
                data: {
                  json: attempted.data.kind === 'tool_calls' ? { tool_calls: attempted.data.calls } : safeJsonParse(attempted.data.text),
                  usage: attempted.data.usage,
                  model: attempted.data.model,
                },
              }
            : attempted,
          latencyMs,
          routing: info.index > 0 ? { attempt: info.index, fallbackOf: info.fallbackOf } : undefined,
        });
        return attempted;
      },
    });

    if (outcome.exhausted) await alertChainExhausted(ctx, outcome.attempts);

    // The selection is made on the first turn (later turns are pinned to the model that answered it), so that is the decision recorded.
    if (round === 0) {
      await recordDecision(ctx, plan.routing, runId, {
        outcome: outcome.result.ok ? 'succeeded' : outcome.exhausted ? 'exhausted' : 'failed',
        attempts: outcome.attempts,
        final: outcome.final,
      });
    }

    if (!outcome.result.ok) {
      return { ok: false, kind: 'provider_error', detail: outcome.result.error.message, stepCount: seq };
    }
    const response = outcome.result;
    if (round === 0 && outcome.final) active = [outcome.final];

    usage = addUsage(usage, response.data.usage);

    if (response.data.kind === 'final') {
      const parsed = parseModelJson(response.data.text);
      if (!parsed.ok) {
        return { ok: false, kind: 'provider_error', detail: 'The model returned output that was not valid JSON.', stepCount: seq };
      }
      return { ok: true, json: parsed.json, usage, stepCount: seq };
    }

    // `tool_calls`. Echo the model's own request back as an assistant turn —
    // the exact blocks it produced, unmodified — then answer each one with a
    // `tool_result` in the next user turn. That pairing is what lets the
    // provider verify its own tool_use ids on the following call.
    messages.push({
      role: 'assistant',
      content: response.data.calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })),
    });

    // A model may ask for several tools in ONE turn, and they run concurrently. Each must record under its OWN step number, decided here
    // before any of them starts: when each read and then advanced a shared counter, three parallel calls all wrote the same `seq`, the
    // unique (run, seq) index refused two of them, and a run that did a dozen things left one row in its trace (found on the first real-model
    // run of the Ad Manager).
    const base = seq;
    const results = await Promise.all(
      response.data.calls.map(async (call, index) => {
        const started2 = Date.now();
        const result = await dispatch({ name: call.name, input: call.input });
        await recordToolCall(ctx.admin, {
          organizationId: ctx.job.organization_id,
          runId,
          seq: base + index,
          toolName: call.name,
          input: call.input,
          result,
          latencyMs: Date.now() - started2,
        });
        return { call, result };
      }),
    );
    seq = base + response.data.calls.length;

    messages.push({
      role: 'user',
      content: results.map(({ call, result }) => ({
        type: 'tool_result' as const,
        toolUseId: call.id,
        content: result.ok ? result.data : result.error.message,
        isError: !result.ok,
      })),
    });
  }

  return {
    ok: false,
    kind: 'tool_limit_exceeded',
    detail: `The model asked for tools ${MAX_TOOL_ROUNDS} times in a row without answering.`,
    stepCount: seq,
  };
}

/**
 * `JSON.parse`, reported through the same `Result<StructuredResponse>` shape
 * `recordModelCall` already accepts — so a `tool_calls` turn's "malformed"
 * case (which cannot happen; the model asked for tools, not for an answer)
 * never needs this, and a `final` turn's does. Kept separate from the
 * `JSON.parse` in `callModelWithTools`'s own body because that one has to
 * short-circuit the function on failure and this one has to keep recording
 * the step either way — the two calls are not answering the same question.
 */
function safeJsonParse(text: string): unknown {
  try {
    const parsed = parseModelJson(text);
    if (parsed.ok) return parsed.json;
    throw new Error('not json');
  } catch {
    return { error: 'not valid JSON', raw: text.slice(0, 500) };
  }
}
