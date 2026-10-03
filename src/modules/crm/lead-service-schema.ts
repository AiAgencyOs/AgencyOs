import { z } from 'zod';

/**
 * SCR-006 — the service a lead asked about, as free text. Bounded to 80
 * characters by the column's own CHECK (`leads_service_is_short`); an empty
 * string clears it. Not a catalogue: the leads list offers the distinct
 * values already recorded as suggestions, never as a rule.
 */
export const setLeadServiceSchema = z.object({
  leadId: z.uuid(),
  service: z.string().trim().max(80),
});

export type SetLeadServiceInput = z.infer<typeof setLeadServiceSchema>;
