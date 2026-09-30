import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-028 — what the Requirements dashboard needs beyond the counts:
 * the recent CHANGES to requirements across every project (change
 * requests raised or decided, scope versions frozen, plan questions
 * raised), and the live plan per project so "Request clarification" can
 * be raised from the dashboard through the plan's own door. Bounded
 * reads, newest first; every failure refuses.
 */
export type RecentRequirementChange = {
  id: string;
  kind: 'change_request' | 'scope_frozen' | 'plan_question' | 'requirement_decided';
  projectId: string;
  projectName: string;
  summary: string;
  status: string | null;
  at: string;
  href: string;
};

export type RequirementsProjectPlan = { projectId: string; projectName: string; planId: string | null; planStatus: string | null; hasActiveScope: boolean };

export async function readRecentRequirementChanges(limit = 12): Promise<RecentRequirementChange[]> {
  const supabase = await createClient();
  const [projects, crs, scopes, questions] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name').is('deleted_at', null).limit(1000),
    supabase.schema('projects').from('change_requests').select('id, project_id, requested, status, classification, created_at, decided_at, updated_at').order('updated_at', { ascending: false }).limit(limit),
    supabase.schema('projects').from('scope_versions').select('id, project_id, version, frozen_at').not('frozen_at', 'is', null).order('frozen_at', { ascending: false }).limit(limit),
    supabase.schema('projects').from('plan_clarifications').select('id, question, status, created_at, project_plans:plan_id(project_id)').order('created_at', { ascending: false }).limit(limit),
  ]);
  if (projects.error) unreadable('readRecentRequirementChanges.projects', projects.error);
  if (crs.error) unreadable('readRecentRequirementChanges.changeRequests', crs.error);
  if (scopes.error) unreadable('readRecentRequirementChanges.scopes', scopes.error);
  if (questions.error) unreadable('readRecentRequirementChanges.questions', questions.error);

  const name = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const out: RecentRequirementChange[] = [];
  for (const cr of crs.data ?? []) {
    const decided = cr.decided_at !== null;
    out.push({
      id: `cr:${cr.id}`,
      kind: decided ? 'requirement_decided' : 'change_request',
      projectId: cr.project_id,
      projectName: name.get(cr.project_id) ?? 'Project',
      summary: decided ? `Change request ${cr.status.replace(/_/g, ' ')}: “${cr.requested}”` : `Change request raised: “${cr.requested}”`,
      status: cr.classification ?? cr.status,
      at: decided ? (cr.decided_at as string) : cr.created_at,
      href: `/projects/${cr.project_id}/scope`,
    });
  }
  for (const sv of scopes.data ?? []) {
    out.push({ id: `sv:${sv.id}`, kind: 'scope_frozen', projectId: sv.project_id, projectName: name.get(sv.project_id) ?? 'Project', summary: `Scope v${sv.version} frozen as the baseline`, status: 'frozen', at: sv.frozen_at as string, href: `/projects/${sv.project_id}/scope` });
  }
  for (const q of questions.data ?? []) {
    const embedded = q.project_plans as unknown as { project_id: string } | { project_id: string }[] | null;
    const pid = Array.isArray(embedded) ? embedded[0]?.project_id : embedded?.project_id;
    if (!pid) continue;
    out.push({ id: `q:${q.id}`, kind: 'plan_question', projectId: pid, projectName: name.get(pid) ?? 'Project', summary: `Question raised on the plan: “${q.question}”`, status: q.status, at: q.created_at, href: `/projects/${pid}/plan` });
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, limit);
}

/** Every live project with its newest non-superseded plan, for the dashboard's clarification and change-request doors. */
export async function listRequirementsProjectPlans(): Promise<RequirementsProjectPlan[]> {
  const supabase = await createClient();
  const [projects, plans, scopes] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name, status').is('deleted_at', null).is('archived_at', null).order('name', { ascending: true }).limit(500),
    supabase.schema('projects').from('project_plans').select('id, project_id, version, status').neq('status', 'superseded').order('version', { ascending: false }).limit(2000),
    supabase.schema('projects').from('scope_versions').select('project_id').eq('status', 'active').limit(2000),
  ]);
  if (projects.error) unreadable('listRequirementsProjectPlans.projects', projects.error);
  if (plans.error) unreadable('listRequirementsProjectPlans.plans', plans.error);
  if (scopes.error) unreadable('listRequirementsProjectPlans.scopes', scopes.error);

  const planByProject = new Map<string, { id: string; status: string }>();
  for (const p of plans.data ?? []) if (!planByProject.has(p.project_id)) planByProject.set(p.project_id, { id: p.id, status: p.status });
  const active = new Set((scopes.data ?? []).map((s) => s.project_id));

  return (projects.data ?? []).map((p) => ({
    projectId: p.id,
    projectName: p.name,
    planId: planByProject.get(p.id)?.id ?? null,
    planStatus: planByProject.get(p.id)?.status ?? null,
    hasActiveScope: active.has(p.id),
  }));
}
