import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What is in the way, across every project — SCR-039's dependencies /
 * blockers panel on the Development dashboard.
 *
 * Two registers hold "in the way": the newest plan's dependency register
 * (`plan_dependencies` still `pending`, `requested` or `blocked` — not
 * received, not written off) and tasks somebody marked `blocked`. The
 * portfolio row already counts blocked tasks; this names them and the
 * dependencies beside them so the panel can say what, not just how many.
 */

export type ProjectBlockers = {
  projectId: string;
  projectName: string;
  planVersion: number | null;
  dependencies: { id: string; kind: string; description: string; ownerRole: string; status: string; neededByPhase: string }[];
  blockedTasks: { id: string; title: string; priority: string }[];
};

const UNMET = new Set(['pending', 'requested', 'blocked']);

export async function readBlockersAcrossProjects(): Promise<ProjectBlockers[]> {
  const supabase = await createClient();

  const [projects, plans, tasks] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name').is('deleted_at', null),
    supabase.schema('projects').from('project_plans').select('id, project_id, version').neq('status', 'superseded').order('version', { ascending: false }),
    supabase.schema('projects').from('tasks').select('id, project_id, title, priority').eq('status', 'blocked').order('created_at', { ascending: true }),
  ]);
  if (projects.error) unreadable('readBlockersAcrossProjects.projects', projects.error);
  if (plans.error) unreadable('readBlockersAcrossProjects.plans', plans.error);
  if (tasks.error) unreadable('readBlockersAcrossProjects.tasks', tasks.error);

  // The newest live plan per project.
  const planByProject = new Map<string, { id: string; version: number }>();
  for (const p of plans.data ?? []) if (!planByProject.has(p.project_id)) planByProject.set(p.project_id, { id: p.id, version: p.version });

  const planIds = [...planByProject.values()].map((p) => p.id);
  const dependenciesByPlan = new Map<string, ProjectBlockers['dependencies']>();
  if (planIds.length > 0) {
    const { data, error } = await supabase
      .schema('projects')
      .from('plan_dependencies')
      .select('id, plan_id, kind, description, owner_role, status, needed_by_phase')
      .in('plan_id', planIds)
      .in('status', [...UNMET]);
    if (error) unreadable('readBlockersAcrossProjects.dependencies', error);
    for (const d of data ?? []) {
      const list = dependenciesByPlan.get(d.plan_id) ?? [];
      list.push({ id: d.id, kind: d.kind, description: d.description, ownerRole: d.owner_role, status: d.status, neededByPhase: d.needed_by_phase });
      dependenciesByPlan.set(d.plan_id, list);
    }
  }

  const tasksByProject = new Map<string, ProjectBlockers['blockedTasks']>();
  for (const t of tasks.data ?? []) {
    const list = tasksByProject.get(t.project_id) ?? [];
    list.push({ id: t.id, title: t.title, priority: t.priority });
    tasksByProject.set(t.project_id, list);
  }

  return (projects.data ?? [])
    .map((p) => {
      const plan = planByProject.get(p.id);
      return {
        projectId: p.id,
        projectName: p.name,
        planVersion: plan?.version ?? null,
        dependencies: plan ? (dependenciesByPlan.get(plan.id) ?? []) : [],
        blockedTasks: tasksByProject.get(p.id) ?? [],
      };
    })
    .filter((p) => p.dependencies.length > 0 || p.blockedTasks.length > 0)
    .sort((a, b) => b.blockedTasks.length + b.dependencies.length - (a.blockedTasks.length + a.dependencies.length));
}
