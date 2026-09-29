import { z } from 'zod';

/**
 * SCR-069 — an access review of one membership. Mirrors
 * `security.record_access_review` (20261001150000): `confirmed`, or
 * `revoke_requested` with a note. The review records a judgement; suspending
 * the membership is `core.set_membership_status`'s own door.
 */
export const ACCESS_REVIEW_DECISIONS = ['confirmed', 'revoke_requested'] as const;
export type AccessReviewDecision = (typeof ACCESS_REVIEW_DECISIONS)[number];

export const recordAccessReviewSchema = z
  .object({
    membershipId: z.uuid('Not a membership id.'),
    decision: z.enum(ACCESS_REVIEW_DECISIONS),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.decision !== 'revoke_requested' || (v.note ?? '').length > 0, {
    message: 'Asking for access to go needs a note saying why.',
    path: ['note'],
  });
export type RecordAccessReviewInput = z.infer<typeof recordAccessReviewSchema>;
