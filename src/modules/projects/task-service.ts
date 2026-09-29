import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { updateTaskSchema, type UpdateTaskInput } from './task-schema';

/**
 * Edit a task's own fields — title, description, priority, assignee, due
 * date. `task.write`, the same capability `createTask` and `setTaskStatus`
 * take, and `tasks_write` at the database decides again.
 *
 * Only the fields present in the input are written: the drawer sends what
 * changed, and an absent field is never mistaken for a clear. A zero-row
 * update is reported as `updated: false` rather than success — RLS hiding
 * the row and the row not existing look the same from here, and neither is
 * a change that happened.
 */
export async function updateTask(input: UpdateTaskInput): Promise<Result<{ updated: boolean }>> {
  const parsed = updateTaskSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid task change.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'task.write')) {
    return err('FORBIDDEN', 'You do not have permission to change a task.');
  }

  const patch: Record<string, string | null> = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.description !== undefined) patch.description = parsed.data.description || null;
  if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
  if (parsed.data.assigneeId !== undefined) patch.assignee_id = parsed.data.assigneeId;
  if (parsed.data.dueOn !== undefined) patch.due_on = parsed.data.dueOn;

  const supabase = await createClient();
  const { error, count } = await supabase
    .schema('projects')
    .from('tasks')
    .update(patch, { count: 'exact' })
    .eq('id', parsed.data.taskId);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'updateTask', detail: error.message }));
    return err('INTERNAL', 'Could not change the task.');
  }
  if ((count ?? 0) === 0) return err('NOT_FOUND', 'Task not found.');
  return ok({ updated: true });
}
