import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * One task, with everything the schema already ties to it — SCR-041.
 *
 * The development tab draws a task as a title and a status select. Every
 * other fact a person opening it wants was a foreign key away and read by
 * nothing: the module and feature it sits under, the scope items that
 * feature carries (`scope_items.feature_id`), who holds it (`assignee_id`
 * → the internal roster), the deliverables its module has produced
 * (`deliverables.module_id`, the evidence a "done" has to point at), and
 * the plan dependencies still outstanding on the project's current plan.
 *
 * `projects.tasks` has no checklist, notes, attachments or comments
 * (bucket B of the gap register), so none are drawn.
 */

export type TaskDetail = {
  task: {
    id: string;
    projectId: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    dueOn: string | null;
    estimateHours: number | null;
    completedAt: string | null;
    createdAt: string;
    assignee: { userId: string; fullName: string; email: string } | null;
    requirementVersionId: string | null;
    startOn: string | null;
    labels: string[];
    milestone: { id: string; name: string } | null;
    parent: { id: string; title: string } | null;
  };
  /** Subtasks of this task (20261004100000), oldest first. */
  subtasks: { id: string; title: string; status: string; dueOn: string | null; assigneeId: string | null; assigneeName: string | null }[];
  module: { id: string; name: string; status: string } | null;
  feature: { id: string; name: string; status: string } | null;
  scopeItems: { id: string; title: string; inclusion: string; acceptanceCriteria: string | null; scopeVersion: number; scopeStatus: string }[];
  evidence: { id: string; kind: string; version: number; title: string; status: string; artifactUrl: string | null }[];
  /** The project's newest plan — where a clarification can be raised. */
  plan: { id: string; version: number; status: string } | null;
  dependencies: { id: string; kind: string; description: string; ownerRole: string; status: string; neededByPhase: string }[];
};

const UNMET_DEPENDENCY = new Set(['pending', 'requested', 'blocked']);

export async function readTaskDetail(projectId: string, taskId: string): Promise<TaskDetail | null> {
  const supabase = await createClient();

  const { data: task, error: taskError } = await supabase
    .schema('projects')
    .from('tasks')
    .select(
      'id, project_id, title, description, status, priority, due_on, estimate_hours, completed_at, created_at, assignee_id, module_id, feature_id, requirement_version_id, start_on, labels, milestone_id, parent_task_id',
    )
    .eq('id', taskId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (taskError) unreadable('readTaskDetail.task', taskError);
  if (!task) return null;

  const [module, feature, assignee, evidence, plan] = await Promise.all([
    task.module_id
      ? supabase.schema('projects').from('modules').select('id, name, status').eq('id', task.module_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    task.feature_id
      ? supabase.schema('projects').from('features').select('id, name, status').eq('id', task.feature_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    task.assignee_id
      ? supabase
          .schema('core')
          .from('memberships')
          .select('user_id, users:user_id(full_name, email)')
          .eq('user_id', task.assignee_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    task.module_id
      ? supabase
          .schema('projects')
          .from('deliverables')
          .select('id, kind, version, title, status, artifact_url')
          .eq('module_id', task.module_id)
          .order('version', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .schema('projects')
      .from('project_plans')
      .select('id, version, status')
      .eq('project_id', projectId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (module.error) unreadable('readTaskDetail.module', module.error);
  if (feature.error) unreadable('readTaskDetail.feature', feature.error);
  if (assignee.error) unreadable('readTaskDetail.assignee', assignee.error);
  if (evidence.error) unreadable('readTaskDetail.evidence', evidence.error);
  if (plan.error) unreadable('readTaskDetail.plan', plan.error);

  const [milestoneRes, parentRes, subtaskRes] = await Promise.all([
    task.milestone_id ? supabase.schema('projects').from('milestones').select('id, name').eq('id', task.milestone_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    task.parent_task_id ? supabase.schema('projects').from('tasks').select('id, title').eq('id', task.parent_task_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.schema('projects').from('tasks').select('id, title, status, due_on, assignee_id').eq('parent_task_id', taskId).order('created_at', { ascending: true }),
  ]);
  if (milestoneRes.error) unreadable('readTaskDetail.milestone', milestoneRes.error);
  if (parentRes.error) unreadable('readTaskDetail.parent', parentRes.error);
  if (subtaskRes.error) unreadable('readTaskDetail.subtasks', subtaskRes.error);
  const subtaskRows = subtaskRes.data ?? [];
  const subtaskPeople = [...new Set(subtaskRows.map((r) => r.assignee_id).filter((id): id is string => id !== null))];
  const subtaskNames = new Map<string, string>();
  if (subtaskPeople.length > 0) {
    const { data: people, error: peopleError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', subtaskPeople);
    if (peopleError) unreadable('readTaskDetail.subtaskPeople', peopleError);
    for (const u of people ?? []) subtaskNames.set(u.id, u.full_name || u.email);
  }

  let scopeItems: TaskDetail['scopeItems'] = [];
  if (task.feature_id) {
    const { data: items, error: itemsError } = await supabase
      .schema('projects')
      .from('scope_items')
      .select('id, title, inclusion, acceptance_criteria, scope_version_id')
      .eq('feature_id', task.feature_id);
    if (itemsError) unreadable('readTaskDetail.scopeItems', itemsError);
    const versionIds = [...new Set((items ?? []).map((i) => i.scope_version_id))];
    const versions = new Map<string, { version: number; status: string }>();
    if (versionIds.length > 0) {
      const { data: versionRows, error: versionsError } = await supabase
        .schema('projects')
        .from('scope_versions')
        .select('id, version, status')
        .in('id', versionIds);
      if (versionsError) unreadable('readTaskDetail.scopeVersions', versionsError);
      for (const v of versionRows ?? []) versions.set(v.id, { version: v.version, status: v.status });
    }
    scopeItems = (items ?? []).map((i) => ({
      id: i.id,
      title: i.title,
      inclusion: i.inclusion,
      acceptanceCriteria: i.acceptance_criteria,
      scopeVersion: versions.get(i.scope_version_id)?.version ?? 0,
      scopeStatus: versions.get(i.scope_version_id)?.status ?? 'unknown',
    }));
  }

  let dependencies: TaskDetail['dependencies'] = [];
  if (plan.data) {
    const { data: deps, error: depsError } = await supabase
      .schema('projects')
      .from('plan_dependencies')
      .select('id, kind, description, owner_role, status, needed_by_phase')
      .eq('plan_id', plan.data.id);
    if (depsError) unreadable('readTaskDetail.dependencies', depsError);
    dependencies = (deps ?? [])
      .filter((d) => UNMET_DEPENDENCY.has(d.status))
      .map((d) => ({ id: d.id, kind: d.kind, description: d.description, ownerRole: d.owner_role, status: d.status, neededByPhase: d.needed_by_phase }));
  }

  const assigneeRow = assignee.data as { user_id: string; users: { full_name: string | null; email: string } | null } | null;

  return {
    task: {
      id: task.id,
      projectId: task.project_id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueOn: task.due_on,
      estimateHours: task.estimate_hours === null ? null : Number(task.estimate_hours),
      completedAt: task.completed_at,
      createdAt: task.created_at,
      assignee: assigneeRow
        ? { userId: assigneeRow.user_id, fullName: assigneeRow.users?.full_name ?? assigneeRow.users?.email ?? 'Unknown', email: assigneeRow.users?.email ?? '' }
        : null,
      requirementVersionId: task.requirement_version_id,
      startOn: task.start_on,
      labels: task.labels ?? [],
      milestone: milestoneRes.data ? { id: milestoneRes.data.id, name: milestoneRes.data.name } : null,
      parent: parentRes.data ? { id: parentRes.data.id, title: parentRes.data.title } : null,
    },
    subtasks: subtaskRows.map((r) => ({ id: r.id, title: r.title, status: r.status, dueOn: r.due_on, assigneeId: r.assignee_id, assigneeName: r.assignee_id ? (subtaskNames.get(r.assignee_id) ?? null) : null })),
    module: module.data ? { id: module.data.id, name: module.data.name, status: module.data.status } : null,
    feature: feature.data ? { id: feature.data.id, name: feature.data.name, status: feature.data.status } : null,
    scopeItems,
    evidence: (evidence.data ?? []).map((d) => ({ id: d.id, kind: d.kind, version: d.version, title: d.title, status: d.status, artifactUrl: d.artifact_url })),
    plan: plan.data ? { id: plan.data.id, version: plan.data.version, status: plan.data.status } : null,
    dependencies,
  };
}
