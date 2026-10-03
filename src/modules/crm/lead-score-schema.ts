import { z } from 'zod';

/**
 * ADM-88 — Decision: reversed by the owner on 2026-09-29. The two doors
 * that recompute a lead's score from `lead-score.ts`: one lead, or every
 * open lead in the organisation. Neither takes a number: the score is
 * computed, never typed.
 */

export const rescoreLeadSchema = z.object({
  leadId: z.uuid(),
});
export type RescoreLeadInput = z.infer<typeof rescoreLeadSchema>;

/** The shape stored in `crm.leads.score_reasons` — what the page expands. */
export const leadScoreReasonSchema = z.object({
  code: z.string(),
  points: z.number().int(),
  detail: z.string(),
});
export const leadScoreReasonsSchema = z.array(leadScoreReasonSchema).min(1);
export type LeadScoreReasonRow = z.infer<typeof leadScoreReasonSchema>;
