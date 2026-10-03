import { z } from 'zod';

/**
 * SCR-049 — the release candidate's rollback plan and smoke checklist,
 * recorded on the PROJECT's release record (`projects.release_records`,
 * 20261006500100), so they can be written before any handover exists. Both
 * are reports the release gate shows; neither is read by
 * `projects.mark_production_ready`.
 */

export const setRollbackPlanSchema = z.object({
  projectId: z.uuid(),
  /** Blank clears it. */
  rollbackPlan: z.string().trim().max(8000),
});
export type SetRollbackPlanInput = z.infer<typeof setRollbackPlanSchema>;

export const setSmokeItemSchema = z.object({
  projectId: z.uuid(),
  label: z.string().trim().min(1, 'Name the check.').max(200),
  done: z.boolean(),
  remove: z.boolean().default(false),
});
export type SetSmokeItemInput = z.infer<typeof setSmokeItemSchema>;

/** "Record post-deploy verification": a dated statement that the deployed release was checked. */
export const VERIFICATION_ENVIRONMENTS = ['staging', 'production', 'other'] as const;
export const VERIFICATION_OUTCOMES = ['passed', 'partial', 'failed'] as const;

export const recordVerificationSchema = z
  .object({
    projectId: z.uuid(),
    environment: z.enum(VERIFICATION_ENVIRONMENTS),
    outcome: z.enum(VERIFICATION_OUTCOMES),
    deliverableId: z.uuid().optional(),
    notes: z.string().trim().max(2000).optional(),
    evidenceUrl: z.url().optional(),
  })
  .refine((v) => v.outcome === 'passed' || (v.notes && v.notes.length > 0), {
    message: 'Say what was found: a partial or failed verification needs notes.',
    path: ['notes'],
  });
export type RecordVerificationInput = z.infer<typeof recordVerificationSchema>;
