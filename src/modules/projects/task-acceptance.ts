/**
 * SCR-041 — who may finish a task, and on what evidence.
 *
 * The PDF's guardrails: "Developer cannot decide own work is finally accepted"
 * and "Task completion requires evidence and downstream QA where applicable".
 * The database trigger `projects.require_acceptance_to_finish` (migration
 * 20261008130000) refuses a person's move to `done` unless a delivery-management
 * role makes it, the task has evidence, and no defect raised against it is still
 * open or fixed-but-unverified. This module is the same rule in words, so the
 * service answers with a sentence rather than "Could not change the status".
 *
 * Pure: no server-only imports.
 */

export const TASK_ACCEPTANCE_DB_ERRORS = {
  notYours: 'task_acceptance_not_yours',
  needsEvidence: 'task_needs_evidence',
  unverifiedDefect: 'task_has_unverified_defect',
} as const;

export const TASK_ACCEPTANCE_MESSAGES = {
  notYours:
    'The person who does the work does not accept it. Mark it ready for QA with evidence; an owner, ops admin or delivery lead accepts it as done.',
  needsEvidence: 'A task is done only with evidence on it. Open the task and submit evidence first.',
  unverifiedDefect:
    'A defect raised against this task is still open, or fixed and waiting for QA to verify it. The task is done once QA has verified the fix.',
} as const;

/** The sentence for a database refusal of a move to done, or null when the error is something else. */
export function taskAcceptanceProblem(dbMessage: string | null | undefined): string | null {
  const text = dbMessage ?? '';
  if (text.includes(TASK_ACCEPTANCE_DB_ERRORS.notYours)) return TASK_ACCEPTANCE_MESSAGES.notYours;
  if (text.includes(TASK_ACCEPTANCE_DB_ERRORS.needsEvidence)) return TASK_ACCEPTANCE_MESSAGES.needsEvidence;
  if (text.includes(TASK_ACCEPTANCE_DB_ERRORS.unverifiedDefect)) return TASK_ACCEPTANCE_MESSAGES.unverifiedDefect;
  return null;
}
