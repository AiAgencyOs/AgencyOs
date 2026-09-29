import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { bugTrend, type BugTrendPoint } from './bug-trend';
import { compareToBudgets, listMetricResults, listPerformanceBudgets, listStabilityIncidents, type BudgetComparison } from './performance-queries';

export { bugTrend, type BugTrendPoint } from './bug-trend';

/**
 * Bucket F's QA summaries — SCR-044 (recent runs, bug trend, release
 * candidate, org-wide evidence) and SCR-049 (security and performance
 * summaries beside the QA one). Every figure is a count of real rows read
 * under RLS; nothing is derived from a stored flag.
 */

export type RecentRun = {
  id: string;
  projectId: string;
  projectName: string;
  deliverableId: string;
  deliverableVersion: number | null;
  suite: string;
  status: string;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
  total: number;
  startedAt: string | null;
  endedAt: string | null;
  executedAt: string;
  rerunOf: string | null;
  evidenceUrl: string | null;
};

/** The newest runs across every project, open first. */
export async function listRecentRuns(limit = 25): Promise<RecentRun[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('id, project_id, deliverable_id, suite, status, passed, failed, skipped, blocked, total, started_at, ended_at, executed_at, rerun_of, evidence_url')
    .order('status', { ascending: false })
    .order('executed_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listRecentRuns', error);
  const rows = data ?? [];
  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  const deliverableIds = [...new Set(rows.map((r) => r.deliverable_id))];
  const [projects, deliverables] = await Promise.all([
    projectIds.length > 0 ? supabase.schema('projects').from('projects').select('id, name').in('id', projectIds) : Promise.resolve({ data: [], error: null }),
    deliverableIds.length > 0 ? supabase.schema('projects').from('deliverables').select('id, version').in('id', deliverableIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (projects.error) unreadable('listRecentRuns.projects', projects.error);
  if (deliverables.error) unreadable('listRecentRuns.deliverables', deliverables.error);
  const nameById = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const versionById = new Map((deliverables.data ?? []).map((d) => [d.id, d.version]));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: nameById.get(r.project_id) ?? 'Unknown project',
    deliverableId: r.deliverable_id,
    deliverableVersion: versionById.get(r.deliverable_id) ?? null,
    suite: r.suite,
    status: r.status,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    blocked: r.blocked,
    total: r.total,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    executedAt: r.executed_at,
    rerunOf: r.rerun_of,
    evidenceUrl: r.evidence_url,
  }));
}

export async function readBugTrend(weeks = 12): Promise<BugTrendPoint[]> {
  const supabase = await createClient();
  const since = new Date(Date.now() - (weeks + 1) * 7 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .schema('qa')
    .from('defects')
    .select('created_at, status, updated_at')
    .or(`created_at.gte.${since},status.eq.open,status.eq.fixed`)
    .limit(10_000);
  if (error) unreadable('readBugTrend', error);
  return bugTrend((data ?? []).map((d) => ({ createdAt: d.created_at, status: d.status, updatedAt: d.updated_at })), new Date(), weeks);
}

export type ReleaseCandidate = { projectId: string; projectName: string; deliverableId: string; version: number; title: string; status: string; productionReadyAt: string | null };

/** SCR-044: the latest build per project — the release candidate — with its status. */
export async function listReleaseCandidates(): Promise<ReleaseCandidate[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('deliverables')
    .select('id, project_id, version, title, status')
    .eq('kind', 'build')
    .order('version', { ascending: false })
    .limit(2000);
  if (error) unreadable('listReleaseCandidates', error);
  const latest = new Map<string, { id: string; project_id: string; version: number; title: string; status: string }>();
  for (const d of data ?? []) if (!latest.has(d.project_id)) latest.set(d.project_id, d);
  const projectIds = [...latest.keys()];
  if (projectIds.length === 0) return [];
  const { data: projects, error: pError } = await supabase.schema('projects').from('projects').select('id, name, production_ready_at').in('id', projectIds).is('deleted_at', null);
  if (pError) unreadable('listReleaseCandidates.projects', pError);
  return (projects ?? [])
    .map((p) => {
      const d = latest.get(p.id)!;
      return { projectId: p.id, projectName: p.name, deliverableId: d.id, version: d.version, title: d.title, status: d.status, productionReadyAt: p.production_ready_at };
    })
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

export type OrgEvidenceSummary = {
  projects: number;
  runs: number;
  openRuns: number;
  runsWithEvidence: number;
  passed: number;
  failed: number;
  blocked: number;
  defectsRaised: number;
  defectsVerified: number;
  incidentsOpen: number;
  byProject: { projectId: string; projectName: string; runs: number; passed: number; failed: number; blocked: number; defectsOpen: number; defectsVerified: number }[];
};

/** SCR-044 "Generate QA evidence summary" — org-wide, all time, every figure a count of rows. */
export async function readOrgEvidenceSummary(): Promise<OrgEvidenceSummary> {
  const supabase = await createClient();
  const [runs, defects, incidents, projects] = await Promise.all([
    supabase.schema('qa').from('test_runs').select('project_id, status, passed, failed, blocked, evidence_url').limit(20_000),
    supabase.schema('qa').from('defects').select('project_id, status').limit(20_000),
    supabase.schema('qa').from('stability_incidents').select('id').is('resolved_at', null).limit(5000),
    supabase.schema('projects').from('projects').select('id, name').is('deleted_at', null).limit(2000),
  ]);
  if (runs.error) unreadable('readOrgEvidenceSummary.runs', runs.error);
  if (defects.error) unreadable('readOrgEvidenceSummary.defects', defects.error);
  if (incidents.error) unreadable('readOrgEvidenceSummary.incidents', incidents.error);
  if (projects.error) unreadable('readOrgEvidenceSummary.projects', projects.error);

  const byProject = new Map<string, OrgEvidenceSummary['byProject'][number]>();
  const nameById = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const row = (projectId: string) => {
    const existing = byProject.get(projectId);
    if (existing) return existing;
    const fresh = { projectId, projectName: nameById.get(projectId) ?? 'Unknown project', runs: 0, passed: 0, failed: 0, blocked: 0, defectsOpen: 0, defectsVerified: 0 };
    byProject.set(projectId, fresh);
    return fresh;
  };
  let openRuns = 0;
  let runsWithEvidence = 0;
  for (const r of runs.data ?? []) {
    const p = row(r.project_id);
    p.runs += 1;
    p.passed += r.passed;
    p.failed += r.failed;
    p.blocked += r.blocked;
    if (r.status === 'open') openRuns += 1;
    if (r.evidence_url) runsWithEvidence += 1;
  }
  let defectsVerified = 0;
  for (const d of defects.data ?? []) {
    const p = row(d.project_id);
    if (d.status === 'open' || d.status === 'fixed') p.defectsOpen += 1;
    if (d.status === 'verified') {
      p.defectsVerified += 1;
      defectsVerified += 1;
    }
  }
  const all = [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
  return {
    projects: all.length,
    runs: (runs.data ?? []).length,
    openRuns,
    runsWithEvidence,
    passed: all.reduce((n, p) => n + p.passed, 0),
    failed: all.reduce((n, p) => n + p.failed, 0),
    blocked: all.reduce((n, p) => n + p.blocked, 0),
    defectsRaised: (defects.data ?? []).length,
    defectsVerified,
    incidentsOpen: (incidents.data ?? []).length,
    byProject: all,
  };
}

// ── SCR-049: security and performance summaries for one project ───────────

export type SecuritySummary = {
  runs: number;
  latest: { id: string; passed: number; failed: number; total: number; executedAt: string; evidenceUrl: string | null } | null;
  openSecurityDefects: number;
};

/** What security-suite runs found on a project, and how many open defects mention security. */
export async function readSecuritySummary(projectId: string): Promise<SecuritySummary> {
  const supabase = await createClient();
  const [runs, defects] = await Promise.all([
    supabase
      .schema('qa')
      .from('test_runs')
      .select('id, passed, failed, total, executed_at, evidence_url')
      .eq('project_id', projectId)
      .eq('suite', 'security')
      .eq('status', 'closed')
      .order('executed_at', { ascending: false })
      .limit(50),
    supabase.schema('qa').from('defects').select('id, title, environment').eq('project_id', projectId).in('status', ['open', 'fixed']).limit(2000),
  ]);
  if (runs.error) unreadable('readSecuritySummary.runs', runs.error);
  if (defects.error) unreadable('readSecuritySummary.defects', defects.error);
  const latest = runs.data?.[0] ?? null;
  const security = /secur|auth|xss|inject|csrf|leak|token|permission/i;
  return {
    runs: (runs.data ?? []).length,
    latest: latest ? { id: latest.id, passed: latest.passed, failed: latest.failed, total: latest.total, executedAt: latest.executed_at, evidenceUrl: latest.evidence_url } : null,
    openSecurityDefects: (defects.data ?? []).filter((d) => security.test(`${d.title} ${d.environment ?? ''}`)).length,
  };
}

export type PerformanceSummary = {
  runs: number;
  budgets: BudgetComparison[];
  overBudget: number;
  unmeasured: number;
  incidentsOpen: number;
  incidentsTotal: number;
};

/** Performance-suite runs, budgets against their latest results, and stability incidents. */
export async function readPerformanceSummary(projectId: string): Promise<PerformanceSummary> {
  const supabase = await createClient();
  const { data: runs, error } = await supabase.schema('qa').from('test_runs').select('id').eq('project_id', projectId).eq('suite', 'performance').limit(500);
  if (error) unreadable('readPerformanceSummary.runs', error);
  const { data: allRuns, error: allError } = await supabase.schema('qa').from('test_runs').select('id').eq('project_id', projectId).limit(2000);
  if (allError) unreadable('readPerformanceSummary.allRuns', allError);
  const [budgets, results, incidents] = await Promise.all([
    listPerformanceBudgets(projectId),
    listMetricResults((allRuns ?? []).map((r) => r.id)),
    listStabilityIncidents(projectId),
  ]);
  const compared = compareToBudgets(budgets, results);
  return {
    runs: (runs ?? []).length,
    budgets: compared,
    overBudget: compared.filter((b) => b.standing === 'over').length,
    unmeasured: compared.filter((b) => b.standing === 'unmeasured').length,
    incidentsOpen: incidents.filter((i) => i.resolvedAt === null).length,
    incidentsTotal: incidents.length,
  };
}
