import { z } from 'zod';

/**
 * SCR-049 — the release candidate's rollback plan and smoke checklist,
 * recorded on `projects.handovers` (20260929170000). Both are reports the
 * release gate shows; neither is read by `projects.mark_production_ready`.
 */

export const setRollbackPlanSchema = z.object({
  handoverId: z.uuid(),
  /** Blank clears it. */
  rollbackPlan: z.string().trim().max(8000),
});
export type SetRollbackPlanInput = z.infer<typeof setRollbackPlanSchema>;

export const setSmokeItemSchema = z.object({
  handoverId: z.uuid(),
  label: z.string().trim().min(1, 'Name the check.').max(200),
  done: z.boolean(),
  remove: z.boolean().default(false),
});
export type SetSmokeItemInput = z.infer<typeof setSmokeItemSchema>;
