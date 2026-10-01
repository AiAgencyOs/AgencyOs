/**
 * Owner decision Q-B2 — project roles are enforced on that project.
 *
 * `projects.project_members.project_role` says what a person is ON a project.
 * Two of the six roles narrow what the agency role would otherwise allow:
 *
 *   observer     reads, changes nothing on that project;
 *   contributor  changes only a task that is assigned to them.
 *
 * Every other project role, and a person with no roster row, is governed by the
 * agency role as before. The owner, ops admin and delivery lead keep the roster
 * (Q-B3, `project.write`) and are never bound by it. The database enforces the
 * same rule (`projects.project_role_refusal`, a trigger on tasks and on task
 * evidence); this module is the rule in words so the service answers with a
 * sentence and the screens do not offer a control that can only be refused.
 *
 * Pure: no server-only imports, so client components may use it.
 */

export const PROJECT_ROLE_DB_ERRORS = {
  observer: 'project_role_observer_read_only',
  contributor: 'project_role_contributor_own_tasks',
} as const;

export const PROJECT_ROLE_MESSAGES = {
  observer: 'You are an observer on this project: it is read-only for you.',
  contributor: 'You are a contributor on this project: you may change only the tasks assigned to you.',
} as const;

/**
 * The sentence for a person whose project role is `role` changing a task held by `assigneeId`, or null when allowed.
 * `manager` is true for the roles that keep the roster (owner, ops admin, delivery lead): never bound.
 */
export function projectRoleProblem(input: { role: string | null | undefined; manager: boolean; userId: string; assigneeId: string | null | undefined }): string | null {
  if (input.manager) return null;
  if (input.role === 'observer') return PROJECT_ROLE_MESSAGES.observer;
  if (input.role === 'contributor' && input.assigneeId !== input.userId) return PROJECT_ROLE_MESSAGES.contributor;
  return null;
}

/** The sentence for a database refusal by project role (the trigger error or a door outcome), or null when it is something else. */
export function projectRoleDbProblem(dbMessage: string | null | undefined): string | null {
  const text = dbMessage ?? '';
  if (text.includes(PROJECT_ROLE_DB_ERRORS.observer)) return PROJECT_ROLE_MESSAGES.observer;
  if (text.includes(PROJECT_ROLE_DB_ERRORS.contributor)) return PROJECT_ROLE_MESSAGES.contributor;
  return null;
}

/** Whether a person with this project role may change any task at all (a control for tasks that are not theirs is hidden from an observer and, unless the task is theirs, a contributor). */
export function mayChangeTask(input: { role: string | null | undefined; manager: boolean; userId: string; assigneeId: string | null | undefined }): boolean {
  return projectRoleProblem(input) === null;
}
