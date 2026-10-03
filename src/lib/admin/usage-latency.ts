import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Latency KPIs for /usage — SCR-065. From `ai.agent_runs.latency_ms`, the
 * wall-clock the trigger stamps when a run settles (20261001150000): the
 * most recent settled runs, summarised. Nothing estimated; `null` where no
 * run has a latency yet, never a zero dressed as a figure.
 */

/** How many settled runs the figures are taken over — the most recent ones. */
export const LATENCY_SAMPLE = 500;
/** Run ids per request for the step read: 50 uuids is ~1.9 KB of query string. */
const STEP_ID_CHUNK = 50;

export type LatencyKpis = {
  /** Runs with a recorded latency in the sample. */
  timedRuns: number;
  averageMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  slowestMs: number | null;
  /** Average latency of one model call, from the steps of the same runs. */
  averageModelCallMs: number | null;
};

/** Pure: the percentile of a sorted ascending array (nearest-rank). */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAscending.length) - 1));
  return sortedAscending[rank] ?? null;
}

export function summariseLatencies(runLatencies: readonly number[], stepLatencies: readonly number[]): LatencyKpis {
  const runs = [...runLatencies].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const steps = stepLatencies.filter((n) => Number.isFinite(n) && n >= 0);
  const avg = (xs: readonly number[]) => (xs.length === 0 ? null : Math.round(xs.reduce((s, x) => s + x, 0) / xs.length));
  return {
    timedRuns: runs.length,
    averageMs: avg(runs),
    medianMs: percentile(runs, 50),
    p95Ms: percentile(runs, 95),
    slowestMs: runs.length > 0 ? (runs[runs.length - 1] ?? null) : null,
    averageModelCallMs: avg(steps),
  };
}

export async function readLatencyKpis(): Promise<LatencyKpis> {
  const supabase = await createClient();

  const { data: runs, error } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('id, latency_ms')
    .not('latency_ms', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(LATENCY_SAMPLE);
  if (error) unreadable('readLatencyKpis', error);

  const runRows = runs ?? [];
  const ids = runRows.map((r) => r.id);
  let stepLatencies: number[] = [];
  // The ids travel in the URL of a GET: five hundred of them is ~18 KB, past what
  // PostgREST and the proxies in front of it accept, so the read fails the moment
  // there are enough runs. Ask in chunks that fit.
  for (let i = 0; i < ids.length; i += STEP_ID_CHUNK) {
    const { data: steps, error: stepsError } = await supabase
      .schema('ai')
      .from('agent_steps')
      .select('latency_ms')
      .eq('kind', 'model_call')
      .in('run_id', ids.slice(i, i + STEP_ID_CHUNK))
      .not('latency_ms', 'is', null)
      .limit(5_000);
    if (stepsError) unreadable('readLatencyKpis.steps', stepsError);
    stepLatencies = stepLatencies.concat((steps ?? []).map((s) => Number(s.latency_ms)));
  }

  return summariseLatencies(
    runRows.map((r) => Number(r.latency_ms)),
    stepLatencies,
  );
}
