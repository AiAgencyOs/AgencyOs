import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-021's fuller row: `listMyTasks` in queries.ts answers the list; the
 * drawer, the calendar and the reassign control need the description, the
 * module and the assignee too. A separate reader rather than a widened
 * select on the existing one, so the callers that want the short row keep
 * getting it.
 */
export type MyTaskDetail = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueOn: string | null;
  estimateHours: number | null;
  assigneeId: string | null;
  completedAt: string | null;
  createdAt: string;
  projectId: string;
  projectName: string;
  moduleId: string | null;
  moduleName: string | null;
};

export async function listMyTasksDetailed(userId: string): Promise<MyTaskDetail[]> {
  const supabase = await createClient();

  const { data: taskRows, error: tasksError } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, title, description, status, priority, due_on, estimate_hours, assignee_id, completed_at, created_at, project_id, module_id')
    .eq('assignee_id', userId)
    .neq('status', 'done')
    .order('due_on', { ascending: true, nullsFirst: false });
  if (tasksError) unreadable('listMyTasksDetailed.tasks', tasksError);

  const rows = taskRows ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((t) => t.project_id))];
  const moduleIds = [...new Set(rows.map((t) => t.module_id).filter((id): id is string => id !== null))];

  const [projects, modules] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name').in('id', projectIds),
    moduleIds.length > 0
      ? supabase.schema('projects').from('modules').select('id, name').in('id', moduleIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (projects.error) unreadable('listMyTasksDetailed.projects', projects.error);
  if (modules.error) unreadable('listMyTasksDetailed.modules', modules.error);

  const projectNameById = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const moduleNameById = new Map((modules.data ?? []).map((m) => [m.id, m.name]));

  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    dueOn: t.due_on,
    estimateHours: t.estimate_hours === null ? null : Number(t.estimate_hours),
    assigneeId: t.assignee_id,
    completedAt: t.completed_at,
    createdAt: t.created_at,
    projectId: t.project_id,
    projectName: projectNameById.get(t.project_id) ?? 'Unknown project',
    moduleId: t.module_id,
    moduleName: t.module_id ? (moduleNameById.get(t.module_id) ?? null) : null,
  }));
}

/**
 * My tasks' Completed column: what I finished most recently, and how many in
 * all. `listMyTasksDetailed` leaves done work out on purpose (it is the open
 * list); this is the other half, bounded so the column never grows unbounded.
 */
export async function listMyCompletedTasks(userId: string, limit = 8): Promise<{ tasks: MyTaskDetail[]; total: number }> {
  const supabase = await createClient();
  const { data, error, count } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, title, description, status, priority, due_on, estimate_hours, assignee_id, completed_at, created_at, project_id, module_id', { count: 'exact' })
    .eq('assignee_id', userId)
    .eq('status', 'done')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) unreadable('listMyCompletedTasks', error);
  const rows = data ?? [];
  if (rows.length === 0) return { tasks: [], total: count ?? 0 };
  const projectIds = [...new Set(rows.map((t) => t.project_id))];
  const { data: projects, error: projectsError } = await supabase.schema('projects').from('projects').select('id, name').in('id', projectIds);
  if (projectsError) unreadable('listMyCompletedTasks.projects', projectsError);
  const names = new Map((projects ?? []).map((p) => [p.id, p.name]));
  return {
    total: count ?? rows.length,
    tasks: rows.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      dueOn: t.due_on,
      estimateHours: t.estimate_hours === null ? null : Number(t.estimate_hours),
      assigneeId: t.assignee_id,
      completedAt: t.completed_at,
      createdAt: t.created_at,
      projectId: t.project_id,
      projectName: names.get(t.project_id) ?? 'Unknown project',
      moduleId: t.module_id,
      moduleName: null,
    })),
  };
}
