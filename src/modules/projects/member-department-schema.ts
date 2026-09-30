import { z } from 'zod';

/**
 * A member's department — owner decision 2, migration 20261005100100. The list
 * is fixed in code AND in a CHECK on core.memberships.department; it is not a
 * table an admin can extend. There is no "Online" indicator: the Team tab
 * keeps "last active".
 */
export const DEPARTMENTS = ['Design', 'Development', 'QA', 'Sales', 'Management', 'Operations'] as const;
export type Department = (typeof DEPARTMENTS)[number];

export function isDepartment(value: unknown): value is Department {
  return typeof value === 'string' && (DEPARTMENTS as readonly string[]).includes(value);
}

/** Department per person, from the columns a roster already reads; anything outside the list reads as not set. */
export function departmentOf(value: unknown): Department | null {
  return isDepartment(value) ? value : null;
}

export const setMemberDepartmentSchema = z.object({
  projectId: z.uuid().optional(),
  userId: z.uuid(),
  /** null clears it. */
  department: z.enum(DEPARTMENTS).nullable(),
});
export type SetMemberDepartmentInput = z.input<typeof setMemberDepartmentSchema>;
