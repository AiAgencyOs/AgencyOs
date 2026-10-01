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

/**
 * Owner decision Q-B1: a task reaches Completed only from In review. The database
 * trigger `projects.refuse_completion_outside_review` refuses the move whichever
 * path writes the row; this is the same rule in words.
 */
export const COMPLETION_MESSAGE =
  'A task is completed only from In review. Hand it off for review first (evidence attached, then mark it ready for QA); an owner, ops admin or delivery lead then accepts it as completed.';

/** The error text the database trigger raises; the service maps it to the same sentence. */
export const COMPLETION_DB_ERROR = 'task_completion_requires_review';

/** null when the move is allowed by this rule, otherwise the sentence that says why not. */
export function completingProblem(from: string | null | undefined, to: string): string | null {
  if (to !== 'done') return null;
  if (from === 'done' || from === 'in_review') return null;
  return COMPLETION_MESSAGE;
}

/**
 * Owner decision T1-1: a task can be cancelled (a status) and archived (`archived_at`).
 * The database trigger `projects.guard_task_cancel_and_archive` refuses the moves below
 * whichever path writes the row; this is the same rule in words.
 *   - cancel: from To do, In progress, Blocked or In review (never from Completed);
 *   - cancelled is terminal, except an owner, ops admin or delivery lead reopens it to To do;
 *   - archive / unarchive: owner, ops admin, delivery lead, through `projects.set_task_archived`.
 */
export const CANCEL_FROM_OPEN_MESSAGE = 'A task is cancelled only while it is open. A completed task stays completed; archive it instead.';
export const CANCEL_DB_ERROR_OPEN = 'task_cancel_from_open_only';
export const CANCEL_FORBIDDEN_MESSAGE = 'Only the task’s assignee, an owner, an ops admin or a delivery lead cancels a task.';
export const CANCEL_DB_ERROR_FORBIDDEN = 'task_cancel_requires_owner_or_lead';
export const CANCELLED_TERMINAL_MESSAGE = 'A cancelled task can only be reopened to To do, by an owner, an ops admin or a delivery lead.';
export const CANCELLED_DB_ERROR = 'task_cancelled_is_terminal';
export const ARCHIVE_FORBIDDEN_MESSAGE = 'Only an owner, an ops admin or a delivery lead archives or restores a task.';
export const ARCHIVE_DB_ERROR = 'task_archive_requires_roster_manager';
/** U1-2: cancelling a task needs a reason; the database trigger refuses a cancel without one. */
export const CANCEL_REASON_MESSAGE = 'Say why the task is cancelled: a cancel needs a reason, and the assignee is told it.';
export const CANCEL_DB_ERROR_REASON = 'task_cancel_requires_reason';
/** U1-1: an archived task is read-only until a roster manager restores it. */
export const ARCHIVED_READ_ONLY_MESSAGE = 'This task is archived, so it is read-only. An owner, an ops admin or a delivery lead has to restore it before anything on it can change.';
export const ARCHIVED_DB_ERROR = 'task_archived_read_only';

/** null when a cancel carries a reason (or the move is not a cancel), otherwise the sentence that asks for one. */
export function cancelReasonProblem(from: string | null | undefined, to: string, reason: string | null | undefined): string | null {
  if (to !== 'cancelled' || from === 'cancelled') return null;
  return reason && reason.trim() ? null : CANCEL_REASON_MESSAGE;
}

/** null when the task can be changed, otherwise the sentence that says an archived task is read-only. */
export function archivedTaskProblem(task: { archivedAt?: string | null } | { archived_at?: string | null } | null | undefined): string | null {
  if (!task) return null;
  const at = 'archivedAt' in task ? task.archivedAt : (task as { archived_at?: string | null }).archived_at;
  return at ? ARCHIVED_READ_ONLY_MESSAGE : null;
}

/** null when the move is allowed by this rule, otherwise the sentence that says why not. (Who may do it is the database's call.) */
export function cancellingProblem(from: string | null | undefined, to: string): string | null {
  if (to === 'cancelled' && from !== 'cancelled' && from !== null && from !== undefined && !['todo', 'in_progress', 'blocked', 'in_review'].includes(from)) return CANCEL_FROM_OPEN_MESSAGE;
  if (from === 'cancelled' && to !== 'cancelled' && to !== 'todo') return CANCELLED_TERMINAL_MESSAGE;
  return null;
}

/** The sentence for a database refusal of a cancel / reopen / archive move, or null when the error is something else. */
export function cancelOrArchiveDbProblem(message: string): string | null {
  if (message.includes(CANCEL_DB_ERROR_OPEN)) return CANCEL_FROM_OPEN_MESSAGE;
  if (message.includes(CANCEL_DB_ERROR_FORBIDDEN)) return CANCEL_FORBIDDEN_MESSAGE;
  if (message.includes(CANCELLED_DB_ERROR)) return CANCELLED_TERMINAL_MESSAGE;
  if (message.includes(ARCHIVE_DB_ERROR)) return ARCHIVE_FORBIDDEN_MESSAGE;
  if (message.includes(CANCEL_DB_ERROR_REASON)) return CANCEL_REASON_MESSAGE;
  if (message.includes(ARCHIVED_DB_ERROR)) return ARCHIVED_READ_ONLY_MESSAGE;
  return null;
}

/** A task counts toward progress, health and KPIs unless it is cancelled or archived. */
export function isCountedTask(task: { status: string; archivedAt?: string | null }): boolean {
  return task.status !== 'cancelled' && !task.archivedAt;
}

/** Outstanding work: counted, and not yet completed. A cancelled or archived task is not outstanding. */
export function isOutstandingTask(task: { status: string; archivedAt?: string | null }): boolean {
  return isCountedTask(task) && task.status !== 'done';
}

/**
 * The statuses a plain status select may offer for a task that is currently `from`: Review only when it is already there,
 * Completed only from Review (or when it is already there), Cancelled only while the task is open (or already cancelled),
 * and out of Cancelled only back to To do.
 */
export function selectableStatuses<T extends string>(all: readonly T[], from: string): T[] {
  return all.filter(
    (s) =>
      (s !== 'in_review' || from === 'in_review') &&
      (s !== 'done' || from === 'in_review' || from === 'done') &&
      (s !== 'cancelled' || from === 'cancelled' || ['todo', 'in_progress', 'blocked', 'in_review'].includes(from)) &&
      (from !== 'cancelled' || s === 'cancelled' || s === 'todo'),
  );
}
