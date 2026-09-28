import 'server-only';

import { configuredProviders, hasConfiguredProvider } from '@/lib/ai/router';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The agent registry and provider posture, read-only, for the Admin — areas D,
 * G, N of the control-center audit.
 *
 * Deliberately READ-ONLY: the audit warned that a browser write to `ai.agents`
 * would reopen the cross-tenant break `…380000` closed (the registry is global;
 * `agents_write` is owner-only and there is no per-tenant activation model yet,
 * gated by ADM-82). So this SHOWS enabled / autonomy / model / ceilings /
 * validation and a derived "would run?", and changes nothing. `agents_select`
 * admits any internal role, and the rows carry no secret — the provider status
 * is a single boolean from `hasConfiguredProvider()`, never the key.
 */

export type AgentRow = {
  key: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  autonomyLevel: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  maxSteps: number | null;
  maxCostMinor: number | null;
  disabledReason: string | null;
  definitionVersion: string | null;
  lastValidatedAt: string | null;
};

export type AiStatus = {
  /** True when at least one provider is registered. Never a key. */
  providerConfigured: boolean;
  /** The registered providers by id (ADM-85: several may be), e.g. ['anthropic', 'openai']. */
  providers: readonly string[];
  agents: AgentRow[];
};

export async function aiStatus(): Promise<AiStatus> {
  const providerConfigured = await hasConfiguredProvider();
  const providers = await configuredProviders();

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('ai')
    .from('agents')
    .select(
      'key, display_name, description, enabled, autonomy_level, default_model, default_effort, max_steps, max_cost_minor, disabled_reason, definition_version, last_validated_at',
    )
    .order('key');

  // Refuse on a failed read rather than rendering an empty registry (G-054): a
  // page reporting "0 agents, nothing would run" because the DB did not answer
  // reads as "the AI is off" when it is merely unreadable. `ai.agents` always
  // has rows in a real deployment, so [] here would be a lie, not a fact.
  if (error) unreadable('aiStatus', error);

  const agents: AgentRow[] = (data ?? []).map((a) => ({
    key: a.key,
    displayName: a.display_name,
    description: a.description,
    enabled: a.enabled,
    autonomyLevel: a.autonomy_level,
    defaultModel: a.default_model,
    defaultEffort: a.default_effort,
    maxSteps: a.max_steps,
    maxCostMinor: a.max_cost_minor,
    disabledReason: a.disabled_reason,
    definitionVersion: a.definition_version,
    lastValidatedAt: a.last_validated_at,
  }));

  return { providerConfigured, providers, agents };
}

export type AgentRunRow = {
  id: string;
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

/**
 * SCR-063's drill-down — every run recorded for one agent, most recent first.
 * `/agents` shows the registry (config, whether it would run now); this is
 * what it actually DID. `getAgentUsage()` in usage.ts already aggregates
 * `ai.agent_runs` into org-wide totals; this is the same table filtered to
 * one agent_key, unaggregated, for a reader who wants to see the run itself
 * rather than a sum.
 */
export async function listAgentRuns(agentKey: string, limit = 50): Promise<AgentRunRow[]> {
  const supabase = await createClient();

  const { data, error: runsError } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select(
      'id, trigger, subject_type, subject_id, status, model, input_tokens, output_tokens, cost_minor, step_count, error, created_at',
    )
    .eq('agent_key', agentKey)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (runsError) unreadable('listAgentRuns', runsError);

  return (data ?? []).map((r) => ({
    id: r.id,
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

/** One agent's registry row, or null if the key does not exist. */
export async function getAgent(agentKey: string): Promise<AgentRow | null> {
  const supabase = await createClient();

  const { data, error: agentError } = await supabase
    .schema('ai')
    .from('agents')
    .select(
      'key, display_name, description, enabled, autonomy_level, default_model, default_effort, max_steps, max_cost_minor, disabled_reason, definition_version, last_validated_at',
    )
    .eq('key', agentKey)
    .maybeSingle();

  if (agentError) unreadable('getAgent', agentError);
  if (!data) return null;

  return {
    key: data.key,
    displayName: data.display_name,
    description: data.description,
    enabled: data.enabled,
    autonomyLevel: data.autonomy_level,
    defaultModel: data.default_model,
    defaultEffort: data.default_effort,
    maxSteps: data.max_steps,
    maxCostMinor: data.max_cost_minor,
    disabledReason: data.disabled_reason,
    definitionVersion: data.definition_version,
    lastValidatedAt: data.last_validated_at,
  };
}

export type HandoffRow = {
  id: string;
  correlationId: string;
  fromAgent: string;
  toAgent: string;
  status: string;
  depth: number;
  objective: string;
  projectId: string | null;
  createdAt: string;
  completedAt: string | null;
};

/**
 * Agent-to-agent handoffs — SCR-065's Automations view. `ai.handoffs`
 * already has a real SELECT policy and real writers (sales/service.ts on
 * conversion, the orchestrator at runtime); this is the first reader either
 * has had. Read-only by design — a handoff moves by the agent runtime's own
 * doors, never by an Admin editing a row.
 */
export async function listHandoffs(limit = 100): Promise<HandoffRow[]> {
  const supabase = await createClient();

  const { data, error: handoffsError } = await supabase
    .schema('ai')
    .from('handoffs')
    .select('id, correlation_id, from_agent, to_agent, status, depth, objective, project_id, created_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (handoffsError) unreadable('listHandoffs', handoffsError);

  return (data ?? []).map((h) => ({
    id: h.id,
    correlationId: h.correlation_id,
    fromAgent: h.from_agent,
    toAgent: h.to_agent,
    status: h.status,
    depth: h.depth,
    objective: h.objective,
    projectId: h.project_id,
    createdAt: h.created_at,
    completedAt: h.completed_at,
  }));
}

export type AgentRunTraceRow = AgentRunRow & { agentKey: string };

/**
 * P4-ORCH-ADMINUI's Task Trace — every run across every agent, one list.
 * `listAgentRuns` already reads `ai.agent_runs` for one agent's own detail
 * page (`/agents/:key`); this is the identical row shape unfiltered, ordered
 * by `correlation_id` then `created_at` so every run belonging to the same
 * chain of work sits together — the trace ORCH §28 asks for, not a per-agent
 * fragment of it. No routing engine needed: a correlation chain is already
 * how `ai.agent_runs`/`ai.handoffs` tie a multi-agent task together
 * (G-128's own unit of tracing).
 */
export async function listAllAgentRuns(limit = 200): Promise<AgentRunTraceRow[]> {
  const supabase = await createClient();

  const { data, error: runsError } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select(
      'id, agent_key, trigger, subject_type, subject_id, status, model, input_tokens, output_tokens, cost_minor, step_count, error, created_at, correlation_id',
    )
    .order('correlation_id', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (runsError) unreadable('listAllAgentRuns', runsError);

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

export type FailedRunRow = AgentRunTraceRow;
export type FailedHandoffRow = HandoffRow;

export type FailureQueue = {
  runs: FailedRunRow[];
  handoffs: FailedHandoffRow[];
};

const FAILED_RUN_STATUSES = ['failed', 'budget_exceeded'] as const;
const FAILED_HANDOFF_STATUSES = ['rejected', 'failed_retryable', 'failed_permanent'] as const;

/**
 * P4-ORCH-ADMINUI's Failure Queue — every `ai.agent_runs` row that stopped
 * with `failed`/`budget_exceeded`, and every `ai.handoffs` row that stopped
 * with `rejected`/`failed_retryable`/`failed_permanent`, org-wide. Both
 * tables already carry these exact terminal-failure states (`agent_runs`'s
 * own CHECK, `20260807120008`; `handoffs`'s own CHECK, `20260814120003`) —
 * this is their first combined reader, the same "found only by already
 * knowing to look" gap `listPhaseFourEscalations` closed for Phase 4's own
 * blocked states. Read-only: a failed run or a rejected handoff is retried or
 * abandoned by the agent runtime's own doors, never a click here.
 */
export async function listFailureQueue(limit = 200): Promise<FailureQueue> {
  const supabase = await createClient();

  const [{ data: runs, error: runsError }, { data: handoffs, error: handoffsError }] = await Promise.all([
    supabase
      .schema('ai')
      .from('agent_runs')
      .select(
        'id, agent_key, trigger, subject_type, subject_id, status, model, input_tokens, output_tokens, cost_minor, step_count, error, created_at',
      )
      .in('status', FAILED_RUN_STATUSES)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .schema('ai')
      .from('handoffs')
      .select('id, correlation_id, from_agent, to_agent, status, depth, objective, project_id, created_at, completed_at')
      .in('status', FAILED_HANDOFF_STATUSES)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  if (runsError) unreadable('listFailureQueue.runs', runsError);
  if (handoffsError) unreadable('listFailureQueue.handoffs', handoffsError);

  return {
    runs: (runs ?? []).map((r) => ({
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
    })),
    handoffs: (handoffs ?? []).map((h) => ({
      id: h.id,
      correlationId: h.correlation_id,
      fromAgent: h.from_agent,
      toAgent: h.to_agent,
      status: h.status,
      depth: h.depth,
      objective: h.objective,
      projectId: h.project_id,
      createdAt: h.created_at,
      completedAt: h.completed_at,
    })),
  };
}
