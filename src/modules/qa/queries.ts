import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { Defect, ProjectQuality } from './types';

/**
 * Reads for QA. RLS-scoped and internal only — a client is told what was
 * fixed, not what is currently broken.
 *
 * Every reader refuses rather than answering with a zero, for the same reason
 * the operations page does: a QA board that renders "no open blockers" because the database did
 * not answer is the single most expensive false statement in this system. It
 * is the sentence somebody reads immediately before telling a client the build
 * is ready.
 */

const SELECT =
  'id, severity, status, title, reproduction, expected, actual, environment, evidence_url, resolution, deliverable_id, verified_at, created_at';

export async function listDefects(projectId: string): Promise<Defect[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('qa')
    .from('defects')
    .select(SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) unreadable('listDefects', error);

  return data ?? [];
}

export type OpenDefect = Defect & {
  projectId: string;
  projectName: string;
};

/**
 * Every open defect across every project — SCR-044's QA Dashboard, the org-
 * wide view `listDefects` (scoped to one project's panel) never offered. An
 * owner should not have to open each project to find every open blocker.
 * `verified` and `wontfix` and `fixed`-but-unverified are not "open" — only
 * `open` is: a fix a developer claims is not QA-verified, and this list is
 * specifically what has not been looked at yet (Doc 14's rule that a
 * developer cannot close their own defect).
 */
export async function listOpenDefects(limit = 300): Promise<OpenDefect[]> {
  const supabase = await createClient();

  const { data: defects, error: defectsError } = await supabase
    .schema('qa')
    .from('defects')
    .select(`${SELECT}, project_id`)
    .eq('status', 'open')
    .order('severity', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(limit);
  if (defectsError) unreadable('listOpenDefects.defects', defectsError);

  const rows = defects ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((d) => d.project_id))];
  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', projectIds);
  if (projectsError) unreadable('listOpenDefects.projects', projectsError);

  const nameById = new Map((projects ?? []).map((p) => [p.id, p.name]));

  return rows.map((d) => ({
    ...d,
    projectId: d.project_id,
    projectName: nameById.get(d.project_id) ?? 'Unknown project',
  }));
}

export type OrgTestCoverage = {
  projectsWithPlan: number;
  totalProjects: number;
  runsLast30Days: number;
  passedLast30Days: number;
  failedLast30Days: number;
};

/**
 * How much of the agency's work is actually being tested — SCR-044's other
 * half, confirmed genuinely missing: the org-wide QA dashboard aggregated
 * defects only, never `qa.test_plans`/`.test_runs`, even though both have
 * had a real reader and writer per project (`readTestPlan`, `listTestRuns`)
 * since 20260921170000/180000. "Projects with a plan" and "runs recorded"
 * are exactly the two facts a defect count alone can't answer: a project
 * with zero open defects and zero test runs has not been found clean, it
 * has not been looked at.
 */
export async function readOrgTestCoverage(): Promise<OrgTestCoverage> {
  const supabase = await createClient();

  const { count: totalProjects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null);
  if (projectsError) unreadable('readOrgTestCoverage.projects', projectsError);

  const { data: plans, error: plansError } = await supabase.schema('qa').from('test_plans').select('project_id');
  if (plansError) unreadable('readOrgTestCoverage.plans', plansError);
  const projectsWithPlan = new Set((plans ?? []).map((p) => p.project_id)).size;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: runs, error: runsError } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('passed, failed')
    .gte('executed_at', since);
  if (runsError) unreadable('readOrgTestCoverage.runs', runsError);

  const runRows = runs ?? [];
  return {
    projectsWithPlan,
    totalProjects: totalProjects ?? 0,
    runsLast30Days: runRows.length,
    passedLast30Days: runRows.reduce((sum, r) => sum + r.passed, 0),
    failedLast30Days: runRows.reduce((sum, r) => sum + r.failed, 0),
  };
}

export async function readProjectQuality(projectId: string): Promise<ProjectQuality> {
  const supabase = await createClient();

  // `.single()` rather than reading data[0]: a function that returns no row is
  // a read that could not answer, and this makes it an error travelling the
  // same path as any other rather than a second refusal beside the first.
  const { data, error } = await supabase
    .schema('qa')
    .rpc('project_quality', { p_project_id: projectId })
    .single();

  if (error) unreadable('readProjectQuality', error);

  return data as ProjectQuality;
}

export type TestPlanItemRow = {
  id: string;
  scopeItemId: string;
  scopeItemTitle: string;
  category: string;
  reason: string;
  criticalPath: boolean;
};

export type TestPlanRow = {
  id: string;
  scopeVersionId: string;
  scopeVersionNumber: number;
  draftedByAgent: string | null;
  draftedBy: string | null;
  createdAt: string;
  items: TestPlanItemRow[];
};

/**
 * The test plan for one project, if one has been drafted — SCR-045. At most
 * one plan per scope version (`test_plans_one_per_scope_version`), and at
 * most one active scope version per project, so at most one row here is ever
 * "the" plan; a superseded scope version's old plan stays as history the
 * same way the baseline itself does.
 */
export async function readTestPlan(projectId: string): Promise<TestPlanRow | null> {
  const supabase = await createClient();

  const { data: planRow, error: planError } = await supabase
    .schema('qa')
    .from('test_plans')
    .select('id, scope_version_id, drafted_by_agent, drafted_by, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (planError) unreadable('readTestPlan.plan', planError);
  if (!planRow) return null;

  const { data: versionRow, error: versionError } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('version')
    .eq('id', planRow.scope_version_id)
    .maybeSingle();

  if (versionError) unreadable('readTestPlan.version', versionError);

  const { data: itemRows, error: itemsError } = await supabase
    .schema('qa')
    .from('test_plan_items')
    .select('id, scope_item_id, category, reason, critical_path')
    .eq('plan_id', planRow.id)
    .order('created_at', { ascending: true });

  if (itemsError) unreadable('readTestPlan.items', itemsError);

  const scopeItemIds = [...new Set((itemRows ?? []).map((i) => i.scope_item_id))];
  const { data: scopeItemRows, error: scopeItemsError } =
    scopeItemIds.length > 0
      ? await supabase.schema('projects').from('scope_items').select('id, title').in('id', scopeItemIds)
      : { data: [] as { id: string; title: string }[], error: null };

  if (scopeItemsError) unreadable('readTestPlan.scopeItems', scopeItemsError);

  const titleById = new Map((scopeItemRows ?? []).map((s) => [s.id, s.title]));

  return {
    id: planRow.id,
    scopeVersionId: planRow.scope_version_id,
    scopeVersionNumber: versionRow?.version ?? 0,
    draftedByAgent: planRow.drafted_by_agent,
    draftedBy: planRow.drafted_by,
    createdAt: planRow.created_at,
    items: (itemRows ?? []).map((i) => ({
      id: i.id,
      scopeItemId: i.scope_item_id,
      scopeItemTitle: titleById.get(i.scope_item_id) ?? 'Unknown item',
      category: i.category,
      reason: i.reason,
      criticalPath: i.critical_path,
    })),
  };
}

export type TestRunRow = {
  id: string;
  deliverableId: string;
  suite: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  evidenceUrl: string | null;
  executedAt: string;
};

/**
 * Every test run recorded against any of a project's builds — SCR-046.
 * `qa.record_test_run` (20260921180000) is the only writer; this is its
 * first reader. Newest first: the run somebody just recorded is what they
 * came to confirm.
 */
export async function listTestRuns(projectId: string, limit = 100): Promise<TestRunRow[]> {
  const supabase = await createClient();

  const { data, error: runsError } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('id, deliverable_id, suite, total, passed, failed, skipped, evidence_url, executed_at')
    .eq('project_id', projectId)
    .order('executed_at', { ascending: false })
    .limit(limit);

  if (runsError) unreadable('listTestRuns', runsError);

  return (data ?? []).map((r) => ({
    id: r.id,
    deliverableId: r.deliverable_id,
    suite: r.suite,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    evidenceUrl: r.evidence_url,
    executedAt: r.executed_at,
  }));
}
