import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The Requirements dashboard's three cross-project questions — SCR-028.
 *
 * Every fact here already existed in a table with a reader of its own, per
 * project or per lead: a plan's unsettled clarifications
 * (`projects.plan_clarifications`, on the plan page), the PM Agent's
 * questions to a person (`projects.clarification_requests`), a requirement
 * version the client was shown and has not yet answered
 * (`crm.requirement_versions.sent_for_confirmation_at`, on the lead page),
 * and change requests raised against a frozen baseline (the scope tab). What
 * none of them answered is "across every project, which ones?" — which is
 * the only question a dashboard exists for.
 *
 * Reads under RLS, so a role that cannot see a table gets no rows from it
 * rather than a refusal; a read that *fails* refuses the page (G-054),
 * because "no project has an open question" is the sentence somebody reads
 * before telling a client the scope is settled.
 */

export type ProjectWithOpenQuestions = {
  projectId: string;
  projectName: string;
  planQuestions: number;
  pmQuestions: number;
};

export type ScopeDriftAlert = {
  changeRequestId: string;
  projectId: string;
  projectName: string;
  scopeVersion: number;
  requested: string;
  status: string;
  classification: string | null;
  createdAt: string;
};

export type RequirementsDashboard = {
  projectsWithOpenQuestions: ProjectWithOpenQuestions[];
  awaitingClientConfirmation: number;
  scopeDrift: ScopeDriftAlert[];
};

/** A plan clarification that still needs somebody — the plan page's own definition. */
const SETTLED_PLAN_CLARIFICATION = new Set(['resolved', 'routed_to_change_request']);
/** A change request the baseline no longer has to worry about. */
const SETTLED_CHANGE_REQUEST = new Set(['rejected', 'closed', 'implemented']);

export async function readRequirementsDashboard(): Promise<RequirementsDashboard> {
  const supabase = await createClient();

  // ── open questions, per project ────────────────────────────────────────
  const { data: planClarifications, error: planClarificationsError } = await supabase
    .schema('projects')
    .from('plan_clarifications')
    .select('plan_id, status');
  if (planClarificationsError) unreadable('readRequirementsDashboard.planClarifications', planClarificationsError);

  const openByPlan = new Map<string, number>();
  for (const row of planClarifications ?? []) {
    if (SETTLED_PLAN_CLARIFICATION.has(row.status)) continue;
    openByPlan.set(row.plan_id, (openByPlan.get(row.plan_id) ?? 0) + 1);
  }

  const planQuestionsByProject = new Map<string, number>();
  if (openByPlan.size > 0) {
    const { data: plans, error: plansError } = await supabase
      .schema('projects')
      .from('project_plans')
      .select('id, project_id')
      .in('id', [...openByPlan.keys()]);
    if (plansError) unreadable('readRequirementsDashboard.plans', plansError);
    for (const plan of plans ?? []) {
      planQuestionsByProject.set(
        plan.project_id,
        (planQuestionsByProject.get(plan.project_id) ?? 0) + (openByPlan.get(plan.id) ?? 0),
      );
    }
  }

  // `projects.clarification_requests` (20260928110000) post-dates the
  // generated types, so the rows are typed by hand from the migration.
  const { data: pmQuestionRows, error: pmQuestionsError } = await supabase
    .schema('projects')
    .from('clarification_requests')
    .select('project_id')
    .eq('status', 'open');
  if (pmQuestionsError) unreadable('readRequirementsDashboard.clarificationRequests', pmQuestionsError);

  const pmQuestionsByProject = new Map<string, number>();
  for (const row of (pmQuestionRows ?? []) as { project_id: string }[]) {
    pmQuestionsByProject.set(row.project_id, (pmQuestionsByProject.get(row.project_id) ?? 0) + 1);
  }

  // ── awaiting client confirmation ───────────────────────────────────────
  const { count: awaitingClientConfirmation, error: awaitingError } = await supabase
    .schema('crm')
    .from('requirement_versions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'proposed')
    .not('sent_for_confirmation_at', 'is', null);
  if (awaitingError) unreadable('readRequirementsDashboard.awaitingConfirmation', awaitingError);

  // ── scope drift: a change request against a frozen baseline ────────────
  const { data: changeRequests, error: changeRequestsError } = await supabase
    .schema('projects')
    .from('change_requests')
    .select('id, project_id, scope_version_id, requested, status, classification, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (changeRequestsError) unreadable('readRequirementsDashboard.changeRequests', changeRequestsError);

  const liveRequests = (changeRequests ?? []).filter((cr) => !SETTLED_CHANGE_REQUEST.has(cr.status));
  const versionIds = [...new Set(liveRequests.map((cr) => cr.scope_version_id))];
  const frozenVersions = new Map<string, number>();
  if (versionIds.length > 0) {
    const { data: versions, error: versionsError } = await supabase
      .schema('projects')
      .from('scope_versions')
      .select('id, version, status')
      .in('id', versionIds)
      .in('status', ['active', 'superseded']);
    if (versionsError) unreadable('readRequirementsDashboard.scopeVersions', versionsError);
    for (const v of versions ?? []) frozenVersions.set(v.id, v.version);
  }
  const drift = liveRequests.filter((cr) => frozenVersions.has(cr.scope_version_id));

  // ── names, once ────────────────────────────────────────────────────────
  const projectIds = [
    ...new Set([
      ...planQuestionsByProject.keys(),
      ...pmQuestionsByProject.keys(),
      ...drift.map((cr) => cr.project_id),
    ]),
  ];
  const nameById = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects, error: projectsError } = await supabase
      .schema('projects')
      .from('projects')
      .select('id, name')
      .in('id', projectIds)
      .is('deleted_at', null);
    if (projectsError) unreadable('readRequirementsDashboard.projects', projectsError);
    for (const p of projects ?? []) nameById.set(p.id, p.name);
  }

  const questionProjectIds = new Set([...planQuestionsByProject.keys(), ...pmQuestionsByProject.keys()]);
  const projectsWithOpenQuestions = [...questionProjectIds]
    // A deleted project's questions are nobody's any more.
    .filter((id) => nameById.has(id))
    .map((id) => ({
      projectId: id,
      projectName: nameById.get(id) ?? 'Unknown project',
      planQuestions: planQuestionsByProject.get(id) ?? 0,
      pmQuestions: pmQuestionsByProject.get(id) ?? 0,
    }))
    .sort((a, b) => b.planQuestions + b.pmQuestions - (a.planQuestions + a.pmQuestions));

  return {
    projectsWithOpenQuestions,
    awaitingClientConfirmation: awaitingClientConfirmation ?? 0,
    scopeDrift: drift
      .filter((cr) => nameById.has(cr.project_id))
      .map((cr) => ({
        changeRequestId: cr.id,
        projectId: cr.project_id,
        projectName: nameById.get(cr.project_id) ?? 'Unknown project',
        scopeVersion: frozenVersions.get(cr.scope_version_id) ?? 0,
        requested: cr.requested,
        status: cr.status,
        classification: cr.classification,
        createdAt: cr.created_at,
      })),
  };
}
