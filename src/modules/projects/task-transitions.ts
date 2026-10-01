/**
 * Which task moves are valid — SCR-020 "Move task only through valid state
 * transitions" and SCR-021 "Submit for review".
 *
 * One move has a gate of its own: a task enters Review only through the
 * hand-off (`projects.mark_task_ready_for_qa`): in progress, at least one piece
 * of evidence, and never while blocked. Every other move is an ordinary status
 * change (To do, In progress, Blocked with its blocker, Completed, and back out
 * of Review). The database trigger `projects.refuse_review_without_hand_off`
 * refuses the gated move whichever path writes the row; this module is the same
 * rule in words, so the service answers with a sentence and the selects do not
 * offer a choice that can only be refused.
 *
 * Pure: no server-only imports, so client components may use it.
 */
export const REVIEW_HAND_OFF_MESSAGE =
  'A task goes to review through its hand-off: it has to be in progress with evidence attached, and never while blocked. Open the task, add the evidence, then mark it ready for QA.';

/** The error text the database trigger raises; the service maps it to the same sentence. */
export const REVIEW_HAND_OFF_DB_ERROR = 'task_review_requires_hand_off';

/** null when the move is allowed by this rule, otherwise the sentence that says why not. */
export function enteringReviewProblem(from: string | null | undefined, to: string): string | null {
  if (to !== 'in_review') return null;
  if (from === 'in_review') return null;
  return REVIEW_HAND_OFF_MESSAGE;
}

/** The statuses a plain status select may offer for a task that is currently `from`: Review only when it is already there. */
export function selectableStatuses<T extends string>(all: readonly T[], from: string): T[] {
  return all.filter((s) => s !== 'in_review' || from === 'in_review');
}
