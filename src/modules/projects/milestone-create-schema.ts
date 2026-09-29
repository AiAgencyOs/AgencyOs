import { z } from 'zod';

/**
 * SCR-022 — create a milestone from a day (migration 20261001120000).
 * An UNPRICED milestone: no payment share, so the plan's 100% rule and
 * every invoice are untouched. Pricing stays with the payment plan door.
 */
export const addUnpricedMilestoneSchema = z.object({
  projectId: z.uuid(),
  name: z.string().trim().min(1, 'A milestone needs a name.').max(200),
  dueOn: z.iso.date().optional(),
});

export type AddUnpricedMilestoneInput = z.input<typeof addUnpricedMilestoneSchema>;
