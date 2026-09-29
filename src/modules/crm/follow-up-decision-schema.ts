import { z } from 'zod';

/**
 * SCR-013 — a person's decision about a follow-up sequence: reschedule
 * (a new due time), complete, or cancel. Every one carries a reason; the
 * database door (`crm.decide_follow_up_sequence`, 20261001110000) refuses
 * one without and records it as the sequence's stop reason.
 */
export const FOLLOW_UP_DECISIONS = ['reschedule', 'complete', 'cancel'] as const;
export type FollowUpDecision = (typeof FOLLOW_UP_DECISIONS)[number];

export const decideFollowUpSequenceSchema = z
  .object({
    sequenceId: z.uuid(),
    action: z.enum(FOLLOW_UP_DECISIONS),
    reason: z.string().trim().min(1, 'Say why, in a sentence.').max(500),
    /** ISO instant; required for a reschedule. */
    nextDueAt: z.iso.datetime().optional(),
  })
  .refine((v) => v.action !== 'reschedule' || Boolean(v.nextDueAt), { message: 'A reschedule needs the new time.', path: ['nextDueAt'] });
export type DecideFollowUpSequenceInput = z.infer<typeof decideFollowUpSequenceSchema>;
