import { z } from 'zod';

/**
 * Project members — SCR-025 (migration 20261001120000). Who is on a
 * project and in what role; the roster a PM chooses before the first task
 * exists. The Board's assignee lists read from it and fall back to the
 * organisation roster when a project has no members.
 */
export const PROJECT_ROLES = ['project_manager', 'designer', 'developer', 'qa', 'contributor', 'observer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  project_manager: 'Project manager',
  designer: 'Designer',
  developer: 'Developer',
  qa: 'QA',
  contributor: 'Contributor',
  observer: 'Observer',
};

export const addProjectMemberSchema = z.object({
  projectId: z.uuid(),
  userId: z.uuid(),
  projectRole: z.enum(PROJECT_ROLES).default('contributor'),
});

export const setProjectMemberRoleSchema = z.object({
  memberId: z.uuid(),
  projectRole: z.enum(PROJECT_ROLES),
});

export const removeProjectMemberSchema = z.object({ memberId: z.uuid() });

export type AddProjectMemberInput = z.input<typeof addProjectMemberSchema>;
export type SetProjectMemberRoleInput = z.input<typeof setProjectMemberRoleSchema>;
export type RemoveProjectMemberInput = z.input<typeof removeProjectMemberSchema>;

/**
 * The Board's assignee list: the project's members when it has any, else
 * the whole internal roster. Pure, so the rule is testable without a
 * database — and so it can never silently become "members only" and hide
 * every assignee on a project nobody has staffed yet.
 */
export function assigneeCandidates<T extends { userId: string }>(members: readonly T[], roster: readonly T[]): { people: T[]; source: 'members' | 'roster' } {
  return members.length > 0 ? { people: [...members], source: 'members' } : { people: [...roster], source: 'roster' };
}
