/**
 * Pure derivations for the agent runs explorer (`/usage/runs`) — no
 * next/headers, no server-only, so the arithmetic is unit-tested without a
 * database. Everything here reads what the runtime recorded; nothing is
 * estimated. When there are no runs the averages are `null`, not `0`: a page
 * showing "avg 0 steps" for an agency that has never run an agent would be
 * reporting a fact it does not have.
 */

export type RunSummaryInput = {
  status: string;
  stepCount: number;
  costMinor: number;
};

export type RunSummary = {
  runs: number;
  failed: number;
  /** Mean `step_count` across the rows, rounded to one decimal; null when there are no rows. */
  avgSteps: number | null;
  /** Sum of `cost_minor` across the rows — minor units, as stored. */
  totalCostMinor: number;
};

/** A run the runtime gave up on. Only `failed` — a cancelled or still-running run is not a failure. */
export function isFailedRun(status: string): boolean {
  return status === 'failed';
}

export function summariseRuns(rows: readonly RunSummaryInput[]): RunSummary {
  if (rows.length === 0) return { runs: 0, failed: 0, avgSteps: null, totalCostMinor: 0 };

  let failed = 0;
  let steps = 0;
  let cost = 0;
  for (const r of rows) {
    if (isFailedRun(r.status)) failed += 1;
    steps += r.stepCount;
    cost += r.costMinor;
  }

  return {
    runs: rows.length,
    failed,
    avgSteps: Math.round((steps / rows.length) * 10) / 10,
    totalCostMinor: cost,
  };
}

/**
 * Wall-clock duration of a run in milliseconds, from `started_at` /
 * `finished_at`. Null unless both are stored and finish is not before start —
 * a half-recorded run has no duration, and a negative one is a clock lie the
 * page should not repeat.
 */
export function runDurationMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** `1.2s`, `840ms`, `2m 05s` — for a step latency or a run duration. */
export function formatDurationMs(ms: number | null): string | null {
  if (ms === null || Number.isNaN(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * The tool a step called, if its recorded `request` names one. The runtime
 * stores the request as free JSON; a `tool` or `name` string at the top level
 * is what a tool-call step carries. Anything else is not guessed at.
 */
export function stepToolName(request: unknown): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const rec = request as Record<string, unknown>;
  for (const key of ['tool', 'tool_name', 'name'] as const) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** The distinct values of one field, in first-seen order, blanks dropped. */
export function distinctValues<T>(rows: readonly T[], pick: (row: T) => string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = pick(r);
    if (v) seen.add(v);
  }
  return [...seen];
}
