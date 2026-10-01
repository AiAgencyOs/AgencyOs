import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type TaskDependencyRow = { dependsOnTaskId: string; title: string; status: string };
export type TaskDependencies = {
  /** The tasks this task waits for. */
  dependsOn: TaskDependencyRow[];
  /** The tasks that wait for this one. */
  blocks: TaskDependencyRow[];
  /** Other tasks of the project this one could be made to depend on (not itself, not already listed, not one that already waits for it). */
  candidates: { id: string; title: string; status: string }[];
};

/** R2-1 — the dependency card of the task page. */
export async function readTaskDependencies(projectId: string, taskId: string): Promise<TaskDependencies> {
  const supabase = await createClient();
  const [forward, backward, tasks] = await Promise.all([
    supabase.schema('projects').from('task_dependencies').select('depends_on_task_id').eq('task_id', taskId),
    supabase.schema('projects').from('task_dependencies').select('task_id').eq('depends_on_task_id', taskId),
    supabase.schema('projects').from('tasks').select('id, title, status, archived_at').eq('project_id', projectId).order('title').limit(500),
  ]);
  if (forward.error) unreadable('readTaskDependencies.forward', forward.error);
  if (backward.error) unreadable('readTaskDependencies.backward', backward.error);
  if (tasks.error) unreadable('readTaskDependencies.tasks', tasks.error);
  const byId = new Map((tasks.data ?? []).map((t) => [t.id, t]));
  const waitsFor = new Set((forward.data ?? []).map((r) => r.depends_on_task_id));
  const waitingOnMe = new Set((backward.data ?? []).map((r) => r.task_id));
  const row = (id: string): TaskDependencyRow | null => {
    const t = byId.get(id);
    return t ? { dependsOnTaskId: t.id, title: t.title, status: t.status } : null;
  };
  return {
    dependsOn: [...waitsFor].map(row).filter((r): r is TaskDependencyRow => r !== null),
    blocks: [...waitingOnMe].map(row).filter((r): r is TaskDependencyRow => r !== null),
    candidates: (tasks.data ?? []).filter((t) => t.id !== taskId && t.status !== 'cancelled' && t.archived_at === null && !waitsFor.has(t.id) && !waitingOnMe.has(t.id)).map((t) => ({ id: t.id, title: t.title, status: t.status })),
  };
}
