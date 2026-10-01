import { z } from 'zod';

/**
 * Q-OVERRIDE — a person's Hot / Warm / Cold label beside the computed one. The
 * reason is required either way; a null label clears the override.
 */
export const overrideLeadHeatSchema = z.object({
  leadId: z.uuid(),
  /** Null clears the override. */
  label: z.enum(['Hot', 'Warm', 'Cold']).nullable(),
  reason: z.string().trim().min(1, 'Say why, in a sentence.').max(500),
});
export type OverrideLeadHeatInput = z.input<typeof overrideLeadHeatSchema>;
