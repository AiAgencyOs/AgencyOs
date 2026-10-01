import { z } from 'zod';

/**
 * A requirement's priority, assignee and linked files — owner decisions 5 and
 * 6, migration 20261005100300. They live beside the frozen scope row, never in
 * it, so they stay editable after the scope is frozen (the frozen wording never
 * changes).
 */
export const REQUIREMENT_PRIORITIES = ['high', 'medium', 'low'] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<RequirementPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' };
export const PRIORITY_TONE: Record<RequirementPriority, 'danger' | 'warning' | 'neutral'> = { high: 'danger', medium: 'warning', low: 'neutral' };

export function priorityOf(value: unknown): RequirementPriority | null {
  return typeof value === 'string' && (REQUIREMENT_PRIORITIES as readonly string[]).includes(value) ? (value as RequirementPriority) : null;
}

/** High first, then medium, low, and unset last — the order a list sorts by. */
export function priorityRank(p: RequirementPriority | null): number {
  return p === null ? 3 : REQUIREMENT_PRIORITIES.indexOf(p);
}

export const setRequirementPlanSchema = z.object({
  projectId: z.uuid(),
  scopeItemId: z.uuid(),
  /** null = not set. */
  priority: z.enum(REQUIREMENT_PRIORITIES).nullable(),
  /** null = nobody. */
  assigneeId: z.uuid().nullable(),
});
export type SetRequirementPlanInput = z.input<typeof setRequirementPlanSchema>;

export const requirementFileLinkSchema = z.object({ projectId: z.uuid(), scopeItemId: z.uuid(), fileId: z.uuid() });
export type RequirementFileLinkInput = z.input<typeof requirementFileLinkSchema>;
