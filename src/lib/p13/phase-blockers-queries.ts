import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { BlockedDependencyRow, PhaseThreeRow, PhaseTwoRow, ProjectName } from './phase-blockers';

const LIMIT = 500;

/** Everything waiting in Phases 2 and 3, plus blocked plan dependencies, across the caller's projects (RLS-scoped). */
export async function readPhaseBlockerSources(): Promise<{ phaseTwo: PhaseTwoRow[]; phaseThree: PhaseThreeRow[]; dependencies: BlockedDependencyRow[]; projects: ProjectName[]; capped: boolean }> {
  const supabase = await createClient();

  const two = await supabase
    .schema('projects')
    .from('phase_two')
    .select('project_id, state, blocked_reason, updated_at')
    .in('state', ['waiting_client', 'waiting_admin', 'waiting_finance', 'waiting_planning', 'blocked'])
    .order('updated_at', { ascending: true })
    .limit(LIMIT);
  if (two.error) unreadable('readPhaseBlockerSources.phaseTwo', two.error);

  const three = await supabase
    .schema('projects')
    .from('phase_three')
    .select('project_id, state, blocked_reason, updated_at')
    .in('state', ['waiting_client', 'waiting_admin', 'waiting_review', 'waiting_designer', 'blocked_requirement', 'scope_escalation', 'revision_limit_escalation'])
    .order('updated_at', { ascending: true })
    .limit(LIMIT);
  if (three.error) unreadable('readPhaseBlockerSources.phaseThree', three.error);

  const deps = await supabase
    .schema('projects')
    .from('plan_dependencies')
    .select('plan_id, kind, description, needed_by_phase, updated_at')
    .eq('status', 'blocked')
    .order('updated_at', { ascending: true })
    .limit(LIMIT);
  if (deps.error) unreadable('readPhaseBlockerSources.dependencies', deps.error);

  const planIds = [...new Set((deps.data ?? []).map((d) => d.plan_id))];
  const planProject = new Map<string, string>();
  if (planIds.length > 0) {
    const plans = await supabase.schema('projects').from('project_plans').select('id, project_id, status').in('id', planIds);
    if (plans.error) unreadable('readPhaseBlockerSources.plans', plans.error);
    // a blocker on a superseded plan is history, not a blocker
    for (const p of plans.data ?? []) if (p.status !== 'superseded') planProject.set(p.id, p.project_id);
  }
  const dependencies: BlockedDependencyRow[] = (deps.data ?? []).flatMap((d) => {
    const projectId = planProject.get(d.plan_id);
    return projectId ? [{ project_id: projectId, kind: d.kind, description: d.description, needed_by_phase: d.needed_by_phase, updated_at: d.updated_at }] : [];
  });

  const projectIds = [...new Set([...(two.data ?? []).map((r) => r.project_id), ...(three.data ?? []).map((r) => r.project_id), ...dependencies.map((d) => d.project_id)])];
  let projects: ProjectName[] = [];
  if (projectIds.length > 0) {
    const names = await supabase.schema('projects').from('projects').select('id, name').in('id', projectIds);
    if (names.error) unreadable('readPhaseBlockerSources.projects', names.error);
    projects = names.data ?? [];
  }

  return {
    phaseTwo: two.data ?? [],
    phaseThree: three.data ?? [],
    dependencies,
    projects,
    capped: (two.data?.length ?? 0) >= LIMIT || (three.data?.length ?? 0) >= LIMIT || (deps.data?.length ?? 0) >= LIMIT,
  };
}
