import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { compareRuns, type BaselineComparison, type ComparableRun } from './baseline';

export { compareRuns, type BaselineComparison } from './baseline';

/**
 * SCR-048 "Compare against baseline" — two runs of one project read under
 * RLS, their per-case results and metric results, handed to the pure
 * `compareRuns`. The baseline defaults to the newest CLOSED run of the same
 * suite before the candidate; the page may name another.
 */
async function readRun(projectId: string, runId: string): Promise<ComparableRun | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('id, suite, passed, failed, skipped, blocked, total, executed_at')
    .eq('project_id', projectId)
    .eq('id', runId)
    .maybeSingle();
  if (error) unreadable('readBaselineComparison.run', error);
  if (!data) return null;
  return { id: data.id, suite: data.suite, passed: data.passed, failed: data.failed, skipped: data.skipped, blocked: data.blocked, total: data.total, executedAt: data.executed_at };
}

export async function readBaselineComparison(projectId: string, candidateId: string, baselineId?: string): Promise<BaselineComparison | null> {
  const supabase = await createClient();
  const candidate = await readRun(projectId, candidateId);
  if (!candidate) return null;

  let baseline: ComparableRun | null = null;
  if (baselineId) {
    baseline = await readRun(projectId, baselineId);
  } else {
    const { data, error } = await supabase
      .schema('qa')
      .from('test_runs')
      .select('id, suite, passed, failed, skipped, blocked, total, executed_at')
      .eq('project_id', projectId)
      .eq('suite', candidate.suite)
      .eq('status', 'closed')
      .neq('id', candidate.id)
      .lt('executed_at', candidate.executedAt)
      .order('executed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) unreadable('readBaselineComparison.baseline', error);
    baseline = data
      ? { id: data.id, suite: data.suite, passed: data.passed, failed: data.failed, skipped: data.skipped, blocked: data.blocked, total: data.total, executedAt: data.executed_at }
      : null;
  }
  if (!baseline) return null;

  const [cases, metrics] = await Promise.all([
    supabase.schema('qa').from('test_case_results').select('test_run_id, test_plan_item_id, status').in('test_run_id', [baseline.id, candidate.id]),
    supabase.schema('qa').from('metric_results').select('run_id, metric, value, unit, created_at').in('run_id', [baseline.id, candidate.id]).order('created_at', { ascending: true }),
  ]);
  if (cases.error) unreadable('readBaselineComparison.cases', cases.error);
  if (metrics.error) unreadable('readBaselineComparison.metrics', metrics.error);

  const caseRows = (cases.data ?? []).map((c) => ({ runId: c.test_run_id, planItemId: c.test_plan_item_id, outcome: c.status }));
  // The newest value per metric per run wins; the order above makes the last write the survivor.
  const metricRows = (metrics.data ?? []).map((m) => ({ runId: m.run_id, metric: m.metric, value: Number(m.value), unit: m.unit }));
  const latest = (runId: string) => [...new Map(metricRows.filter((m) => m.runId === runId).map((m) => [m.metric, m])).values()];

  return compareRuns(
    baseline,
    candidate,
    caseRows.filter((c) => c.runId === baseline.id),
    caseRows.filter((c) => c.runId === candidate.id),
    latest(baseline.id),
    latest(candidate.id),
  );
}
