import { z } from 'zod';

/**
 * Marking a payment milestone met — SCR-023.
 *
 * `projects.milestones.status` has always admitted `met`, with
 * `milestones_met_at_set` requiring the moment alongside it, and until this
 * nothing in the repository ever wrote it (migration 20260812120001's own
 * comment says so). A met milestone is consequential: `replace_payment_plan`
 * refuses to touch a plan once any milestone is met. So the door asks for
 * the milestone by id and nothing else — no free-text status, no date to
 * choose; the moment is now.
 */
export const markMilestoneMetSchema = z.object({
  milestoneId: z.uuid(),
});

export type MarkMilestoneMetInput = z.infer<typeof markMilestoneMetSchema>;

/** The statuses a person may mark met from. `pending` is locked (unpaid); `rejected` is over. */
export const MEETABLE_MILESTONE_STATUSES = ['in_progress', 'submitted'] as const;
