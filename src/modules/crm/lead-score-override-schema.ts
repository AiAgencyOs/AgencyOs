import { z } from 'zod';

/**
 * SCR-008 — a person's number beside the model's. The override never
 * replaces the computed score (ADM-88, reversed 2026-09-29): both columns
 * stay on the row and the page shows them side by side. A null score with a
 * reason clears the override; the reason is required either way.
 */
export const overrideLeadScoreSchema = z.object({
  leadId: z.uuid(),
  /** Null clears the override. */
  score: z.number().int().min(0).max(100).nullable(),
  reason: z.string().trim().min(1, 'Say why, in a sentence.').max(500),
});
export type OverrideLeadScoreInput = z.infer<typeof overrideLeadScoreSchema>;
