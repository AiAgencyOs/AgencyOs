import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type TestCaseResultRow = {
  id: string;
  testRunId: string;
  testPlanItemId: string;
  status: string;
  notes: string | null;
  evidenceUrl: string | null;
  executedAt: string;
};

/**
 * Every per-case result on a project's runs, grouped by run — SCR-046.
 * `qa.record_test_case_results` (20260929170000) is the only writer; this
 * is its reader. A case's retest history is its rows across runs, and the
 * page derives that from this same list rather than reading twice.
 */
export async function listTestCaseResults(projectId: string): Promise<Map<string, TestCaseResultRow[]>> {
  const supabase = await createClient();

  const { data: runs, error: runsError } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('id')
    .eq('project_id', projectId);
  if (runsError) unreadable('listTestCaseResults.runs', runsError);

  const runIds = (runs ?? []).map((r) => r.id);
  const byRun = new Map<string, TestCaseResultRow[]>();
  if (runIds.length === 0) return byRun;

  const { data, error } = await supabase
    .schema('qa')
    .from('test_case_results')
    .select('id, test_run_id, test_plan_item_id, status, notes, evidence_url, executed_at')
    .in('test_run_id', runIds)
    .order('executed_at', { ascending: true });
  if (error) unreadable('listTestCaseResults', error);

  for (const r of data ?? []) {
    const list = byRun.get(r.test_run_id) ?? [];
    list.push({
      id: r.id,
      testRunId: r.test_run_id,
      testPlanItemId: r.test_plan_item_id,
      status: r.status,
      notes: r.notes,
      evidenceUrl: r.evidence_url,
      executedAt: r.executed_at,
    });
    byRun.set(r.test_run_id, list);
  }
  return byRun;
}
