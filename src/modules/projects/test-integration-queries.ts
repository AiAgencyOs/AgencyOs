import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What staff see of the test and integration records for one project, from the STORED state (never re-derived here). Every read is guarded (G-054):
 * a failed read is `unreadable`, never rendered as "none", because "no coverage gaps" on a failed read would be a claim this function does not know.
 */

export type IntegrationObservation = {
  connectionId: string;
  name: string;
  health: string;
  checksCounted: number;
  errorRate: number | null;
  lastSuccessAt: string | null;
  lastFailureClass: string | null;
  avgLatencyMs: number | null;
};
export type CoverageGap = { taskId: string; title: string; acceptanceCriteria: string; reason: string };
export type RegressionLinkRow = { id: string; defectId: string; testCaseName: string; state: string; verifiedAt: string | null };
export type TestCaseDraftRow = { id: string; taskId: string; name: string; layer: string; expected: string };
export type DependencyRow = { taskId: string; connectionId: string; held: boolean };

export type TestIntegrationView = {
  observability: IntegrationObservation[];
  gaps: CoverageGap[];
  regressionLinks: RegressionLinkRow[];
  drafts: TestCaseDraftRow[];
  dependencies: DependencyRow[];
};

export async function getTestIntegrationView(projectId: string): Promise<TestIntegrationView> {
  const supabase = await createClient();
  const [observed, gaps, links, drafts, deps] = await Promise.all([
    supabase.schema('projects').rpc('integration_observability' as never, { p_project_id: projectId, p_last: 20 } as never),
    supabase.schema('qa').rpc('coverage_gaps' as never, { p_project_id: projectId } as never),
    supabase.schema('qa').from('regression_links' as never).select('id, defect_id, test_case_name, state, verified_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    supabase.schema('projects').from('test_case_drafts' as never).select('id, task_id, name, layer, expected').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    supabase.schema('projects').from('task_integration_dependencies' as never).select('task_id, connection_id, held').eq('project_id', projectId).limit(200),
  ]);
  if (observed.error) unreadable('integration observability', observed.error);
  if (gaps.error) unreadable('coverage gaps', gaps.error);
  if (links.error) unreadable('regression links', links.error);
  if (drafts.error) unreadable('test case drafts', drafts.error);
  if (deps.error) unreadable('task integration dependencies', deps.error);

  type Row = Record<string, unknown>;
  const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    observability: rows(observed.data).map((r) => ({
      connectionId: String(r.connection_id),
      name: String(r.name),
      health: String(r.health),
      checksCounted: Number(r.checks_counted ?? 0),
      errorRate: num(r.error_rate),
      lastSuccessAt: (r.last_success_at as string | null) ?? null,
      lastFailureClass: (r.last_failure_class as string | null) ?? null,
      avgLatencyMs: num(r.avg_latency_ms),
    })),
    gaps: rows(gaps.data).map((r) => ({ taskId: String(r.task_id), title: String(r.title), acceptanceCriteria: String(r.acceptance_criteria ?? ''), reason: String(r.reason) })),
    regressionLinks: rows(links.data).map((r) => ({ id: String(r.id), defectId: String(r.defect_id), testCaseName: String(r.test_case_name), state: String(r.state), verifiedAt: (r.verified_at as string | null) ?? null })),
    drafts: rows(drafts.data).map((r) => ({ id: String(r.id), taskId: String(r.task_id), name: String(r.name), layer: String(r.layer), expected: String(r.expected) })),
    dependencies: rows(deps.data).map((r) => ({ taskId: String(r.task_id), connectionId: String(r.connection_id), held: r.held === true })),
  };
}
