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

import { resolveProvider } from '@/lib/ai/router';
import type { AiMessage, AiToolSpec, AiUsage, StructuredResponse } from '@/lib/ai/types';
import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';
import { settlementFor } from '@/lib/jobs/retry';
import type { Result } from '@/lib/result';

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
  const { data } = await ctx.admin
    .schema('ai')
    .from('agent_runs')
    .insert({
      organization_id: ctx.job.organization_id,
      agent_key: ctx.agent.key,
      trigger: `job:${ctx.job.id}`,
      subject_type: subject.type,
      subject_id: subject.id,
      status: 'running',
      work_class: ctx.workClass,
      model: ctx.agent.default_model,
      input: subject.input,
      correlation_id: ctx.job.correlation_id ?? ctx.correlationId,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  return data?.id ?? null;
}

export async function finishRun(
  admin: Admin,
  runId: string | null,
  status: string,
  error: string,
  stepCount = 0,
): Promise<void> {
  if (!runId) return;
  await admin
    .schema('ai')
    .from('agent_runs')
    .update({ status, error, step_count: stepCount, finished_at: new Date().toISOString() })
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
          // which only the schema does, further down.
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
    { attemptsMade: job.attempts, maxAttempts: job.max_attempts },
    false,
    Date.now(),
  );

  if (settlement.status === 'dead') {
    logJobParked(job, job.kind, reason);
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
  const provider = resolveProvider(ctx.agent.default_model);

  if (!provider.ok) {
    return { ok: false, kind: 'no_provider', detail: provider.error.message, stepCount: 0 };
  }

  const request = {
    model: ctx.agent.default_model,
    system: spec.systemPrompt,
    messages: [...messages],
    jsonSchema: spec.jsonSchema(),
    schemaName: spec.schemaName,
    effort: ctx.agent.default_effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  };

  const started = Date.now();
  const response = await provider.data.generateStructured(request);
  const latencyMs = Date.now() - started;

  const stepCount = await recordModelCall(ctx.admin, {
    organizationId: ctx.job.organization_id,
    runId,
    seq: 0,
    providerId: provider.data.id,
    request,
    result: response,
    latencyMs,
  });

  if (!response.ok) {
    return { ok: false, kind: 'provider_error', detail: response.error.message, stepCount };
  }

  return { ok: true, json: response.data.json, usage: response.data.usage, stepCount };
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
      request: { tool: args.toolName },
      response: args.result.ok ? { result: args.result.data } : null,
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
const MAX_TOOL_ROUNDS = 4;

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
  spec: { systemPrompt: string; schemaName: string },
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
  const provider = resolveProvider(ctx.agent.default_model);
  if (!provider.ok) {
    return { ok: false, kind: 'no_provider', detail: provider.error.message, stepCount: 0 };
  }
  if (!provider.data.generateWithTools) {
    // Stated rather than a silent fallback to `generateStructured`: a caller
    // that asked for tools and got an answer with none attempted would not
    // know the difference between "the model chose not to" and "this
    // provider cannot".
    return {
      ok: false,
      kind: 'no_provider',
      detail: `${provider.data.id} does not support tool calling.`,
      stepCount: 0,
    };
  }

  const messages: AiMessage[] = [...initialMessages];
  let seq = 0;
  let usage: AiUsage = { inputTokens: 0, outputTokens: 0, costMinor: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const request = {
      model: ctx.agent.default_model,
      system: spec.systemPrompt,
      messages,
      tools,
      effort: ctx.agent.default_effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    };

    const started = Date.now();
    const response = await provider.data.generateWithTools(request);
    const latencyMs = Date.now() - started;

    seq = await recordModelCall(ctx.admin, {
      organizationId: ctx.job.organization_id,
      runId,
      seq,
      providerId: provider.data.id,
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
      result: response.ok
        ? {
            ok: true,
            data: {
              json: response.data.kind === 'tool_calls' ? { tool_calls: response.data.calls } : safeJsonParse(response.data.text),
              usage: response.data.usage,
              model: response.data.model,
            },
          }
        : response,
      latencyMs,
    });

    if (!response.ok) {
      return { ok: false, kind: 'provider_error', detail: response.error.message, stepCount: seq };
    }

    usage = addUsage(usage, response.data.usage);

    if (response.data.kind === 'final') {
      let json: unknown;
      try {
        json = JSON.parse(response.data.text);
      } catch {
        return { ok: false, kind: 'provider_error', detail: 'The model returned output that was not valid JSON.', stepCount: seq };
      }
      return { ok: true, json, usage, stepCount: seq };
    }

    // `tool_calls`. Echo the model's own request back as an assistant turn —
    // the exact blocks it produced, unmodified — then answer each one with a
    // `tool_result` in the next user turn. That pairing is what lets the
    // provider verify its own tool_use ids on the following call.
    messages.push({
      role: 'assistant',
      content: response.data.calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })),
    });

    const results = await Promise.all(
      response.data.calls.map(async (call) => {
        const started2 = Date.now();
        const result = await dispatch({ name: call.name, input: call.input });
        seq = await recordToolCall(ctx.admin, {
          organizationId: ctx.job.organization_id,
          runId,
          seq,
          toolName: call.name,
          result,
          latencyMs: Date.now() - started2,
        });
        return { call, result };
      }),
    );

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
    return JSON.parse(text);
  } catch {
    return { error: 'not valid JSON', raw: text.slice(0, 500) };
  }
}
