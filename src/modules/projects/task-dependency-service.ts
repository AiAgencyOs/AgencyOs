import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { projectRoleDbProblem } from './project-role-guard';
import { taskRoleRefusal } from './project-role-service';
import { ADD_DEPENDENCY_MESSAGES, taskDependencySchema, type TaskDependencyInput } from './task-dependency-schema';

/**
 * R2-1 — add or remove one per-task dependency through the audited doors of
 * migration 20261009500000. `task.write`, bound by the caller's project role on
 * the dependent task; the database re-checks both and writes the audit row.
 */

async function door(fn: 'add_task_dependency' | 'remove_task_dependency', input: TaskDependencyInput, verb: string, done: string): Promise<Result<{ done: true }>> {
  const parsed = taskDependencySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid dependency.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', `You do not have permission to ${verb}.`);
  const roleRefusal = await taskRoleRefusal(context, parsed.data.taskId);
  if (roleRefusal) return roleRefusal;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc(fn, { p_task_id: parsed.data.taskId, p_depends_on_task_id: parsed.data.dependsOnTaskId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: fn, detail: error.message }));
    return err('INTERNAL', `Could not ${verb}.`);
  }
  const outcome = ((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome;
  if (outcome === done) return ok({ done: true });
  const roleProblem = projectRoleDbProblem(outcome);
  if (roleProblem) return err(outcome === 'task_archived_read_only' ? 'CONFLICT' : 'FORBIDDEN', roleProblem);
  if (outcome === 'forbidden') return err('FORBIDDEN', 'The database refused: your role may not change a task.');
  if (outcome && ADD_DEPENDENCY_MESSAGES[outcome]) return err(outcome === 'not_found' ? 'NOT_FOUND' : 'CONFLICT', ADD_DEPENDENCY_MESSAGES[outcome]);
  return err('INTERNAL', `Could not ${verb}.`);
}

export const addTaskDependency = (input: TaskDependencyInput) => door('add_task_dependency', input, 'add a dependency', 'added');
export const removeTaskDependency = (input: TaskDependencyInput) => door('remove_task_dependency', input, 'remove a dependency', 'removed');
