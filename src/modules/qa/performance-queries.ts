import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { MetricResultRow, PerformanceBudgetRow } from './budget-comparison';

export { compareToBudgets, type BudgetComparison } from './budget-comparison';

/**
 * SCR-048 readers: budgets, metric results and incidents for one project,
 * and the comparison of the latest result per metric against its budget.
 * The comparison is a report — a row is "over budget" in words, never a
 * gate: Doc 14 §16 leaves the threshold with the project.
 */

export type { MetricResultRow, PerformanceBudgetRow } from './budget-comparison';
export type StabilityIncidentRow = {
  id: string;
  severity: string;
  summary: string;
  openedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
};

export async function listPerformanceBudgets(projectId: string): Promise<PerformanceBudgetRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .from('performance_budgets')
    .select('id, metric, target, unit, lower_is_better')
    .eq('project_id', projectId)
    .order('metric', { ascending: true });
  if (error) unreadable('listPerformanceBudgets', error);
  return (data ?? []).map((b) => ({ id: b.id, metric: b.metric, target: Number(b.target), unit: b.unit, lowerIsBetter: b.lower_is_better }));
}

/** Metric results across the project's runs, newest first, keyed by run id. */
export async function listMetricResults(runIds: readonly string[]): Promise<Map<string, MetricResultRow[]>> {
  const out = new Map<string, MetricResultRow[]>();
  if (runIds.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .from('metric_results')
    .select('id, run_id, metric, value, unit, created_at')
    .in('run_id', [...runIds])
    .order('created_at', { ascending: false });
  if (error) unreadable('listMetricResults', error);
  for (const r of data ?? []) {
    const list = out.get(r.run_id) ?? [];
    list.push({ id: r.id, runId: r.run_id, metric: r.metric, value: Number(r.value), unit: r.unit, recordedAt: r.created_at });
    out.set(r.run_id, list);
  }
  return out;
}

export async function listStabilityIncidents(projectId: string, limit = 100): Promise<StabilityIncidentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .from('stability_incidents')
    .select('id, severity, summary, opened_at, resolved_at, resolution')
    .eq('project_id', projectId)
    .order('opened_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listStabilityIncidents', error);
  return (data ?? []).map((i) => ({ id: i.id, severity: i.severity, summary: i.summary, openedAt: i.opened_at, resolvedAt: i.resolved_at, resolution: i.resolution }));
}

