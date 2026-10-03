import { z } from 'zod';

/**
 * SCR-043 — a technical dependency (`projects.dependencies`) is open until
 * somebody marks it supplied or waived (20260929190000). The PLAN's register
 * (`plan_dependencies`) is a different thing and keeps its own rule: no
 * write once the plan is active.
 */
export const DEPENDENCY_STATUSES = ['open', 'supplied', 'waived'] as const;
export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number];

export const setDependencyStatusSchema = z.object({
  projectId: z.uuid(),
  dependencyId: z.uuid(),
  status: z.enum(DEPENDENCY_STATUSES),
  note: z.string().trim().max(1000).optional(),
});
export type SetDependencyStatusInput = z.infer<typeof setDependencyStatusSchema>;
