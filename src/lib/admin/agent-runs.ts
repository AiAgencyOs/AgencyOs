import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { distinctValues } from './agent-runs-eval';

/**
 * The agent runs explorer — SCR-065's "run list with filters" and "step trace
 * per run", both from tables that already exist and already have SELECT
 * policies (`agent_runs_select`, `agent_steps_select`: internal roles of the
 * caller's own organisation). Read-only: a run moves by the runtime's own
 * doors, never by an Admin editing a row.
 *
 * `agent-status.ts` reads the same `ai.agent_runs` table for one agent
 * (`listAgentRuns(agentKey)`) and for the dashboard feed; this is the same
 * row shape with optional filters, plus the run-and-its-steps read no screen
 * has had (usage.ts once summed `ai.agent_steps`; nothing rendered them).
 * `unreadable()` on a failed read (G-054): an explorer that renders "no runs"
 * because the DB did not answer reads as "nothing ran".
 */

export type AgentRunListRow = {
  id: string;
  agentKey: string;
  trigger: string;
  subjectType: string | null;
  subjectId: string | null;
  status: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
  stepCount: number;
  error: string | null;
  createdAt: string;
};

export type AgentRunFilters = {
  agentKey?: string;
  status?: string;
  model?: string;
  limit?: number;
};

const RUN_COLUMNS =
  'id, agent_key, trigger, subject_type, subject_id, status, model, input_tokens, output_tokens, cost_minor, step_count, error, created_at';

const DEFAULT_LIMIT = 100;
/** How far back the filter rail looks for distinct agents / statuses / models. */
const FACET_SCAN = 500;

export async function listAgentRuns(filters: AgentRunFilters = {}): Promise<AgentRunListRow[]> {
  const supabase = await createClient();

  let query = supabase
    .schema('ai')
    .from('agent_runs')
    .select(RUN_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT);

  if (filters.agentKey) query = query.eq('agent_key', filters.agentKey);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.model) query = query.eq('model', filters.model);

  const { data, error } = await query;
  if (error) unreadable('listAgentRuns', error);

  return (data ?? []).map((r) => ({
    id: r.id,
    agentKey: r.agent_key,
    trigger: r.trigger,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    status: r.status,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costMinor: r.cost_minor,
    stepCount: r.step_count,
    error: r.error,
    createdAt: r.created_at,
  }));
}

export type AgentRunFacets = {
  agents: string[];
  statuses: string[];
  models: string[];
};

/**
 * The values the filter chips can offer — distinct over the most recent
 * `FACET_SCAN` runs, unfiltered, so choosing one status does not hide the
 * others from the rail. Not a full-table scan: a facet from a run older than
 * the scan window is simply not offered, which is honest for a rail whose
 * list is itself the most recent rows.
 */
export async function listAgentRunFacets(): Promise<AgentRunFacets> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('agent_key, status, model')
    .order('created_at', { ascending: false })
    .limit(FACET_SCAN);
  if (error) unreadable('listAgentRunFacets', error);

  const rows = data ?? [];
  return {
    agents: distinctValues(rows, (r) => r.agent_key).sort(),
    statuses: distinctValues(rows, (r) => r.status).sort(),
    models: distinctValues(rows, (r) => r.model).sort(),
  };
}

export type AgentRunDetail = AgentRunListRow & {
  correlationId: string | null;
  workClass: string | null;
  promptKey: string | null;
  promptVersion: string | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type AgentStepRow = {
  id: string;
  seq: number;
  kind: string;
  tokensIn: number;
  tokensOut: number;
  costMinor: number;
  latencyMs: number | null;
  error: string | null;
  /** The recorded request, as stored — free JSON, surfaced only for a tool name. */
  request: unknown;
  createdAt: string;
};

export type AgentRunWithSteps = { run: AgentRunDetail; steps: AgentStepRow[] };

/**
 * One run and its step trace, or null when the id does not exist (or RLS
 * hides it — the two are indistinguishable by design). The steps are read
 * after the run so a missing run costs one query, not two.
 */
export async function getAgentRunWithSteps(runId: string): Promise<AgentRunWithSteps | null> {
  const supabase = await createClient();

  const { data: run, error: runError } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select(
      `${RUN_COLUMNS}, correlation_id, work_class, prompt_key, prompt_version, cache_read_tokens, cache_write_tokens, started_at, finished_at, updated_at`,
    )
    .eq('id', runId)
    .maybeSingle();
  if (runError) unreadable('getAgentRunWithSteps', runError);
  if (!run) return null;

  const { data: steps, error: stepsError } = await supabase
    .schema('ai')
    .from('agent_steps')
    .select('id, seq, kind, tokens_in, tokens_out, cost_minor, latency_ms, error, request, created_at')
    .eq('run_id', runId)
    .order('seq', { ascending: true });
  if (stepsError) unreadable('getAgentRunWithSteps.steps', stepsError);

  return {
    run: {
      id: run.id,
      agentKey: run.agent_key,
      trigger: run.trigger,
      subjectType: run.subject_type,
      subjectId: run.subject_id,
      status: run.status,
      model: run.model,
      inputTokens: run.input_tokens,
      outputTokens: run.output_tokens,
      costMinor: run.cost_minor,
      stepCount: run.step_count,
      error: run.error,
      createdAt: run.created_at,
      correlationId: run.correlation_id,
      workClass: run.work_class,
      promptKey: run.prompt_key,
      promptVersion: run.prompt_version,
      cacheReadTokens: run.cache_read_tokens,
      cacheWriteTokens: run.cache_write_tokens,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      updatedAt: run.updated_at,
    },
    steps: (steps ?? []).map((s) => ({
      id: s.id,
      seq: s.seq,
      kind: s.kind,
      tokensIn: s.tokens_in,
      tokensOut: s.tokens_out,
      costMinor: s.cost_minor,
      latencyMs: s.latency_ms,
      error: s.error,
      request: s.request,
      createdAt: s.created_at,
    })),
  };
}
