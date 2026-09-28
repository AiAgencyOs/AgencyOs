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

const NAMED_SUITES = ['regression', 'compatibility', 'performance'] as const;
type NamedSuite = (typeof NAMED_SUITES)[number];

export type SuiteCoverage = { suite: NamedSuite; runsLast30Days: number; passedLast30Days: number; failedLast30Days: number };

/**
 * Regression, compatibility and performance, broken out — SCR-048. All
 * three are already recorded per run (`qa.test_runs.suite`, the same CHECK
 * as `TEST_RUN_SUITES`) and shown per-item on each project's QA panel; this
 * is the cross-project rollup neither `listOpenDefects` (defects carry no
 * category) nor `readOrgTestCoverage` (all suites folded into one number)
 * gives a reader who wants these three specifically.
 */
export async function readSuiteCoverage(): Promise<SuiteCoverage[]> {
  const supabase = await createClient();

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('suite, passed, failed')
    .in('suite', NAMED_SUITES)
    .gte('executed_at', since);

  if (error) unreadable('readSuiteCoverage', error);

  const bySuite = new Map<NamedSuite, SuiteCoverage>(
    NAMED_SUITES.map((suite) => [suite, { suite, runsLast30Days: 0, passedLast30Days: 0, failedLast30Days: 0 }]),
  );

  for (const row of data ?? []) {
    const entry = bySuite.get(row.suite as NamedSuite);
    if (!entry) continue;
    entry.runsLast30Days += 1;
    entry.passedLast30Days += row.passed;
    entry.failedLast30Days += row.failed;
  }

  return NAMED_SUITES.map((suite) => bySuite.get(suite)!);
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

export type RetestDefect = Defect & { projectId: string; projectName: string };

/**
 * P4-QAP-ADMINUI's Retests surface — every defect marked `fixed` and not yet
 * `verified`, org-wide. `qa.defects_guard` (20260813120002) already makes
 * `fixed` the one status that can only become `verified` or bounce back to
 * `open`; this is that exact "waiting on somebody to check" pile,
 * `listOpenDefects`'s own shape applied to the other status a QA board needs
 * a queue for. The dashboard's `unverified` count (`readProjectQuality`) has
 * always answered "how many"; this answers "which ones", the same gap
 * `listOpenDefects` closed for `open`.
 */
export async function listRetestQueue(limit = 300): Promise<RetestDefect[]> {
  const supabase = await createClient();

  const { data: defects, error: defectsError } = await supabase
    .schema('qa')
    .from('defects')
    .select(`${SELECT}, project_id`)
    .eq('status', 'fixed')
    .order('severity', { ascending: true })
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (defectsError) unreadable('listRetestQueue.defects', defectsError);

  const rows = defects ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((d) => d.project_id))];
  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', projectIds);
  if (projectsError) unreadable('listRetestQueue.projects', projectsError);

  const nameById = new Map((projects ?? []).map((p) => [p.id, p.name]));

  return rows.map((d) => ({
    ...d,
    projectId: d.project_id,
    projectName: nameById.get(d.project_id) ?? 'Unknown project',
  }));
}

export type ProjectReadiness = {
  projectId: string;
  projectName: string;
  openBlockers: number;
  openMajors: number;
  unverified: number;
  ready: boolean;
};

/**
 * P4-QAP-ADMINUI's Readiness surface, org-wide. `qa.project_quality(uuid)`
 * (20260813120002) already answers this per project on that project's own QA
 * panel; rather than call it once per project (an RPC-per-row N+1 this admin
 * list would otherwise force), the same three counts are derived here from
 * one flat `qa.defects` read, grouped in TypeScript — the identical
 * open/fixed-unverified arithmetic `project_quality` runs in SQL, expressed
 * as a presentation-layer rollup rather than a second RPC. `ready` names the
 * same bar `qa.blocking_defects`/ARCHITECTURE.md §4.8 hold at submission
 * time: no open blocker, no open major, nothing fixed-but-unverified.
 */
export async function readOrgReadiness(): Promise<ProjectReadiness[]> {
  const supabase = await createClient();

  const { data: defects, error: defectsError } = await supabase
    .schema('qa')
    .from('defects')
    .select('project_id, severity, status')
    .in('status', ['open', 'fixed']);
  if (defectsError) unreadable('readOrgReadiness.defects', defectsError);

  const rows = defects ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((d) => d.project_id))];
  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', projectIds);
  if (projectsError) unreadable('readOrgReadiness.projects', projectsError);

  const nameById = new Map((projects ?? []).map((p) => [p.id, p.name]));

  const byProject = new Map<string, ProjectReadiness>();
  for (const id of projectIds) {
    byProject.set(id, {
      projectId: id,
      projectName: nameById.get(id) ?? 'Unknown project',
      openBlockers: 0,
      openMajors: 0,
      unverified: 0,
      ready: true,
    });
  }

  for (const d of rows) {
    const entry = byProject.get(d.project_id);
    if (!entry) continue;
    if (d.status === 'open' && d.severity === 'blocker') entry.openBlockers += 1;
    if (d.status === 'open' && d.severity === 'major') entry.openMajors += 1;
    if (d.status === 'fixed') entry.unverified += 1;
  }

  for (const entry of byProject.values()) {
    entry.ready = entry.openBlockers === 0 && entry.openMajors === 0 && entry.unverified === 0;
  }

  return [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
}

export type UiValidationRow = {
  projectId: string;
  projectName: string;
  version: number;
  status: string;
  qaReviewedAt: string | null;
  missingScreens: number;
  stateGaps: number;
};

/**
 * P4-QAP-ADMINUI's Validation Matrix, org-wide. `handleReviewUIVersion`
 * (`src/modules/qa/handlers.ts`) already writes `qa_findings`/`qa_reviewed_at`
 * and the `qa_review`/`qa_pass`/`qa_changes_required` status onto
 * `projects.ui_versions` per round; the per-project Phase 4 panel already
 * renders one project's own findings list and coverage matrix
 * (`phase-four-panel.tsx`). This is the same verdict, one row per version,
 * across every project — Master's own Admin Panel "IS MANDATORY UI COVERAGE
 * COMPLETE?" asked across the org rather than one workspace at a time.
 */
export async function listUiValidations(limit = 500): Promise<UiValidationRow[]> {
  const supabase = await createClient();

  const { data: versions, error: versionsError } = await supabase
    .schema('projects')
    .from('ui_versions')
    .select('project_id, version, status, qa_findings, qa_reviewed_at')
    .order('qa_reviewed_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (versionsError) unreadable('listUiValidations.versions', versionsError);

  const rows = versions ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((v) => v.project_id))];
  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', projectIds);
  if (projectsError) unreadable('listUiValidations.projects', projectsError);

  const nameById = new Map((projects ?? []).map((p) => [p.id, p.name]));

  return rows.map((v) => {
    const findings = (v.qa_findings ?? null) as { missingScreens?: string[]; stateGaps?: string[] } | null;
    return {
      projectId: v.project_id,
      projectName: nameById.get(v.project_id) ?? 'Unknown project',
      version: v.version,
      status: v.status,
      qaReviewedAt: v.qa_reviewed_at,
      missingScreens: findings?.missingScreens?.length ?? 0,
      stateGaps: findings?.stateGaps?.length ?? 0,
    };
  });
}
