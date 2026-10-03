import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-061 (bucket G-3) — one tool's record: how often it was called in the
 * period, how often the call failed, the last twenty calls, and which
 * agents this organisation has allowed or denied it for
 * (`ai.agent_tool_permissions`). Calls are `ai.agent_steps` rows of kind
 * `tool_call` whose request names the tool (`request->>tool`, the shape
 * `recordToolCall` in app/api/jobs/run/agent-run.ts writes). Nothing is
 * estimated; a failed read refuses.
 */

export const TOOL_PERIOD_DAYS = 30;
const SAMPLE = 2_000;

export type ToolCallRow = {
  stepId: string;
  runId: string;
  seq: number;
  latencyMs: number | null;
  error: string | null;
  createdAt: string;
  /** From the run the step belongs to. */
  agentKey: string | null;
  runStatus: string | null;
};

export type ToolCallStats = {
  periodDays: number;
  calls: number;
  failed: number;
  /** failed / calls, or null when nothing was called. */
  failureRate: number | null;
  averageLatencyMs: number | null;
  recent: ToolCallRow[];
};

export async function readToolCallStats(toolName: string, limit = 20): Promise<ToolCallStats> {
  const supabase = await createClient();
  const since = new Date(Date.now() - TOOL_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_steps')
    .select('id, run_id, seq, latency_ms, error, created_at')
    .eq('kind', 'tool_call')
    .eq('request->>tool', toolName)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SAMPLE);
  if (error) unreadable('readToolCallStats', error);

  const steps = data ?? [];
  const failed = steps.filter((s) => s.error !== null).length;
  const latencies = steps.map((s) => s.latency_ms).filter((l): l is number => l !== null && Number.isFinite(l));
  const recentSteps = steps.slice(0, limit);

  const runIds = [...new Set(recentSteps.map((s) => s.run_id))];
  const runById = new Map<string, { agent_key: string; status: string }>();
  if (runIds.length > 0) {
    const { data: runs, error: runsError } = await supabase.schema('ai').from('agent_runs').select('id, agent_key, status').in('id', runIds);
    if (runsError) unreadable('readToolCallStats.runs', runsError);
    for (const r of runs ?? []) runById.set(r.id, { agent_key: r.agent_key, status: r.status });
  }

  return {
    periodDays: TOOL_PERIOD_DAYS,
    calls: steps.length,
    failed,
    failureRate: steps.length > 0 ? failed / steps.length : null,
    averageLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length) : null,
    recent: recentSteps.map((s) => ({
      stepId: s.id,
      runId: s.run_id,
      seq: s.seq,
      latencyMs: s.latency_ms,
      error: s.error,
      createdAt: s.created_at,
      agentKey: runById.get(s.run_id)?.agent_key ?? null,
      runStatus: runById.get(s.run_id)?.status ?? null,
    })),
  };
}

export type ToolPermissionForTool = { agentKey: string; allowed: boolean; note: string | null; updatedAt: string };

/** Every agent this organisation has recorded an allow or deny for, on one tool. */
export async function listToolPermissionsForTool(toolKey: string): Promise<ToolPermissionForTool[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('ai')
    .from('agent_tool_permissions')
    .select('agent_key, allowed, note, updated_at')
    .eq('tool_key', toolKey)
    .order('agent_key', { ascending: true });
  if (error) unreadable('listToolPermissionsForTool', error);
  return (data ?? []).map((r) => ({ agentKey: r.agent_key, allowed: r.allowed, note: r.note, updatedAt: r.updated_at }));
}
