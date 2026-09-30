import { z } from 'zod';

/**
 * Decision F1 of 2026-09-30: launch is gated on the verified final payment.
 * The owner may override it with a reason (`projects.override_release_payment`).
 */
export const overrideReleasePaymentSchema = z.object({
  projectId: z.uuid(),
  reason: z.string().trim().min(10, 'Say why the release goes out before the final payment is verified — at least ten characters.').max(2000),
});
export type OverrideReleasePaymentInput = z.infer<typeof overrideReleasePaymentSchema>;
