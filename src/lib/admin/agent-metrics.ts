import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What the agents' runs say about themselves — SCR-061 and SCR-063.
 *
 * `agent-status.ts` reads the registry and one agent's run list;
 * `usage.ts` sums the cost ledger. These are the two remaining questions
 * the dashboard asks: how long a task takes, and which models the money
 * went to. Both come from rows the runtime wrote (`ai.agent_runs`,
 * `ai.cost_ledger`); nothing is estimated. `unreadable()` on failure
 * (G-054) — a dashboard showing "0s average" because the database did not
 * answer would be reporting a speed nobody measured.
 */

export type RunMetrics = {
  /** Settled runs with both timestamps, the sample the average is over. */
  timedRuns: number;
  averageSeconds: number | null;
  medianSeconds: number | null;
  failedRuns: number;
  /** Cost and runs per model, from the ledger, largest spend first. */
  byModel: { model: string; runs: number; costMinor: number; share: number }[];
};

const SAMPLE = 500;

export async function readRunMetrics(): Promise<RunMetrics> {
  const supabase = await createClient();

  const [{ data: runs, error: runsError }, { data: ledger, error: ledgerError }] = await Promise.all([
    supabase
      .schema('ai')
      .from('agent_runs')
      .select('status, started_at, finished_at')
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(SAMPLE),
    supabase.schema('ai').from('cost_ledger').select('model, runs, cost_minor').order('day', { ascending: false }).limit(10_000),
  ]);
  if (runsError) unreadable('readRunMetrics.runs', runsError);
  if (ledgerError) unreadable('readRunMetrics.ledger', ledgerError);

  const durations: number[] = [];
  let failedRuns = 0;
  for (const r of runs ?? []) {
    if (r.status === 'failed') failedRuns += 1;
    if (!r.started_at || !r.finished_at) continue;
    const seconds = (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) durations.push(seconds);
  }
  durations.sort((a, b) => a - b);
  const averageSeconds = durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : null;
  const medianSeconds = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : null;

  const perModel = new Map<string, { runs: number; costMinor: number }>();
  let totalCost = 0;
  for (const row of ledger ?? []) {
    const cost = Number(row.cost_minor);
    totalCost += cost;
    const entry = perModel.get(row.model) ?? { runs: 0, costMinor: 0 };
    entry.runs += Number(row.runs);
    entry.costMinor += cost;
    perModel.set(row.model, entry);
  }
  const byModel = [...perModel.entries()]
    .map(([model, v]) => ({ model, runs: v.runs, costMinor: v.costMinor, share: totalCost > 0 ? v.costMinor / totalCost : 0 }))
    .sort((a, b) => b.costMinor - a.costMinor);

  return { timedRuns: durations.length, averageSeconds, medianSeconds, failedRuns, byModel };
}

export type AgentFailure = {
  id: string;
  trigger: string;
  subjectType: string | null;
  subjectId: string | null;
  error: string | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
};

/** One agent's failed runs with the error as written — SCR-063's failures list. */
export async function listAgentFailures(agentKey: string, limit = 25): Promise<AgentFailure[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('id, trigger, subject_type, subject_id, error, model, prompt_version, created_at')
    .eq('agent_key', agentKey)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listAgentFailures', error);

  return (data ?? []).map((r) => ({
    id: r.id,
    trigger: r.trigger,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    error: r.error,
    model: r.model,
    promptVersion: r.prompt_version,
    createdAt: r.created_at,
  }));
}

export type PromptVersionUse = { promptKey: string | null; promptVersion: string | null; runs: number; lastUsedAt: string };

/**
 * Which prompt versions this agent has actually run with, newest first —
 * `agent_runs.prompt_key` / `prompt_version` are stamped per run, so a
 * prompt change is visible as the version the runs carry rather than as a
 * claim the registry makes.
 */
export async function listAgentPromptVersions(agentKey: string): Promise<PromptVersionUse[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('prompt_key, prompt_version, created_at')
    .eq('agent_key', agentKey)
    .order('created_at', { ascending: false })
    .limit(SAMPLE);

  if (error) unreadable('listAgentPromptVersions', error);

  const seen = new Map<string, PromptVersionUse>();
  for (const r of data ?? []) {
    const key = `${r.prompt_key ?? ''}@${r.prompt_version ?? ''}`;
    const entry = seen.get(key);
    if (entry) entry.runs += 1;
    else seen.set(key, { promptKey: r.prompt_key, promptVersion: r.prompt_version, runs: 1, lastUsedAt: r.created_at });
  }
  return [...seen.values()];
}
