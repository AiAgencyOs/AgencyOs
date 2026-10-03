import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The routing log — which model actually served each model call, and what
 * happened when the first choice could not.
 *
 * Read from `ai.agent_steps`, which already records one row per model call
 * with the provider, model, latency and error (and, since failure-time routing,
 * a `routing` marker on every FALLBACK attempt naming the model whose failure
 * led to it). Nothing new is written for this page: a log that is a second copy
 * of the trace would be a second thing to keep true.
 */
export type RoutingLogRow = {
  id: string;
  at: string;
  agentKey: string;
  runId: string;
  provider: string;
  model: string;
  /** 0 for the first choice; 1, 2… for a fallback attempt. */
  attempt: number;
  fallbackOf: string | null;
  latencyMs: number | null;
  failed: boolean;
  error: string | null;
};

type StepRow = {
  id: string;
  created_at: string;
  run_id: string;
  request: { provider?: unknown; model?: unknown; routing?: { attempt?: unknown; fallbackOf?: unknown } | null } | null;
  latency_ms: number | null;
  error: string | null;
  agent_runs: { agent_key: string } | { agent_key: string }[] | null;
};

export async function listRoutingLog(limit = 200): Promise<RoutingLogRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_steps')
    .select('id, created_at, run_id, request, latency_ms, error, agent_runs(agent_key)')
    .eq('kind', 'model_call')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listRoutingLog', error);

  return ((data ?? []) as unknown as StepRow[]).map((row) => {
    const run = Array.isArray(row.agent_runs) ? row.agent_runs[0] : row.agent_runs;
    const routing = row.request?.routing ?? null;
    return {
      id: row.id,
      at: row.created_at,
      agentKey: run?.agent_key ?? '—',
      runId: row.run_id,
      provider: typeof row.request?.provider === 'string' ? row.request.provider : '—',
      model: typeof row.request?.model === 'string' ? row.request.model : '—',
      attempt: typeof routing?.attempt === 'number' ? routing.attempt : 0,
      fallbackOf: typeof routing?.fallbackOf === 'string' ? routing.fallbackOf : null,
      latencyMs: row.latency_ms,
      failed: row.error !== null,
      error: row.error,
    };
  });
}
