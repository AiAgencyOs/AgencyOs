import 'server-only';

import type { AuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { err, type Result } from '@/lib/result';

import { projectRoleProblem } from './project-role-guard';
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
