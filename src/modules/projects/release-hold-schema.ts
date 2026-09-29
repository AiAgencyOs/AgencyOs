import { z } from 'zod';

/**
 * SCR-044 — a release hold (`projects.projects.release_hold_reason`,
 * 20260929190000): the sign-off door refuses while one stands.
 */
const reason = z.string().trim().min(10, 'Say why, in at least ten characters.').max(2000);

export const holdReleaseSchema = z.object({ projectId: z.uuid(), reason });
export type HoldReleaseInput = z.infer<typeof holdReleaseSchema>;

export const liftReleaseHoldSchema = z.object({ projectId: z.uuid(), reason });
export type LiftReleaseHoldInput = z.infer<typeof liftReleaseHoldSchema>;
