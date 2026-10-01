import 'server-only';

import type { AuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, unreadable, type Result } from '@/lib/result';

import { projectRoleDbProblem, projectRoleProblem } from './project-role-guard';
import { readMyProjectRole } from './project-role-queries';

/**
 * Q-B2 at the service: null when the caller may change a task of `projectId` held by `assigneeId`,
 * otherwise the refusal to return. The database trigger says the same thing again for every other writer.
 * The roles that keep the roster (`project.write`: owner, ops admin, delivery lead) are not bound by it.
 */
export async function projectRoleRefusal(context: AuthContext, projectId: string, assigneeId: string | null | undefined): Promise<Result<never> | null> {
  const manager = can(context, 'project.write');
  if (manager) return null;
  const role = await readMyProjectRole(projectId, context.userId);
  const problem = projectRoleProblem({ role, manager, userId: context.userId, assigneeId });
  return problem ? (err('FORBIDDEN', problem) as Result<never>) : null;
}

/** R2-2: the same guard for a change that belongs to a task (comment, time log, checklist, dependency), read from the task itself. */
export async function taskRoleRefusal(context: AuthContext, taskId: string): Promise<Result<never> | null> {
  if (can(context, 'project.write')) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('tasks').select('project_id, assignee_id').eq('id', taskId).maybeSingle();
  if (error) unreadable('taskRoleRefusal', error);
  if (!data) return null;
  return projectRoleRefusal(context, data.project_id, data.assignee_id);
}

/** R2-2: a checklist item's task, then the guard. */
export async function checklistItemRoleRefusal(context: AuthContext, itemId: string): Promise<Result<never> | null> {
  if (can(context, 'project.write')) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('task_checklist_items').select('task_id').eq('id', itemId).maybeSingle();
  if (error) unreadable('checklistItemRoleRefusal', error);
  return data ? taskRoleRefusal(context, data.task_id) : null;
}

/** A database refusal by project role (the trigger said it for a writer the service did not see) as the Result to return, or null. */
export function dbRoleRefusal(dbMessage: string | null | undefined): Result<never> | null {
  const problem = projectRoleDbProblem(dbMessage);
  return problem ? (err('FORBIDDEN', problem) as Result<never>) : null;
}
