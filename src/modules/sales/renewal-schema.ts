import { z } from 'zod';

/**
 * SCR-016 — a renewal or upsell is a NEW opportunity of a stated kind,
 * opened from a completed project of the client (`sales.open_renewal`,
 * 20261001110000). The door refuses a project that is not completed and a
 * lead that already has an open deal.
 */
export const RENEWAL_KINDS = ['renewal', 'upsell'] as const;
export type RenewalKind = (typeof RENEWAL_KINDS)[number];

export const openRenewalSchema = z.object({
  clientAccountId: z.uuid(),
  projectId: z.uuid(),
  kind: z.enum(RENEWAL_KINDS),
  name: z.string().trim().min(1, 'Name the deal.').max(200),
  /** Minor units; 0 when nothing has been discussed yet. */
  valueMinor: z.number().int().nonnegative().max(1_000_000_000_000).default(0),
});
export type OpenRenewalInput = z.input<typeof openRenewalSchema>;
