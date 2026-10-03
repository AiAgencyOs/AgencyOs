import { z } from 'zod';

/** SCR-040 — turn a plan's deliverables into the Phase 5 breakdown, once. */
export const breakDownPlanSchema = z.object({
  projectId: z.uuid(),
  planId: z.uuid(),
});

export type BreakDownPlanInput = z.infer<typeof breakDownPlanSchema>;
