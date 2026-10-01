/**
 * Owner decision Q-C3 — Start Task is gated by two checks (SCR-041, "one-task-at-a-time
 * execution surface enforcing requirement check, dependency check, ...").
 *
 *   requirement check  the task is linked to a requirement version, or to a feature that
 *                      carries an included or optional scope item;
 *   dependency check   (R2-1) every task this task depends on is done, cancelled or
 *                      archived (S2-3; a dependency across projects is refused when it is written); the failing task is
 *                      named. The plan-level "any pending plan dependency" check is replaced.
 *
 * The database says it in `projects.task_start_check` and refuses in `projects.start_task`
 * (`no_requirement`, `dependencies_open`); this module is the same sentences, so the button
 * and the response name the failing reason. Pure: no server-only imports.
 */

export const START_REQUIREMENT_MESSAGE =
  'Requirement check failed: this task is not linked to a requirement or scope item. Link it to the feature that delivers one, or ask the requirement on the task page.';

export const START_DEPENDENCY_MESSAGE =
  'Dependency check failed: a task this one depends on is not done yet. Finish it first, or remove the dependency.';

export type TaskStartCheck = {
  startable: boolean;
  requirementOk: boolean;
  openDependencies: number;
  /** The sentence the button shows when the task cannot start; null when it can. */
  reason: string | null;
};

/** S2-3: a dependency is satisfied when the task it names is done, cancelled or archived. Mirrors `projects.task_start_check`. */
export function dependencyIsSatisfied(task: { status: string; archivedAt?: string | null; cancelledAt?: string | null }): boolean {
  return task.status === 'done' || task.status === 'cancelled' || task.status === 'archived' || Boolean(task.archivedAt) || Boolean(task.cancelledAt);
}

/** Up to this many failing tasks are named in the sentence; the rest are counted. */
const NAMED = 3;

/**
 * The pure rule, for the sentence and for tests: the same two checks, in the same order.
 * R2-1: dependencies are per task: `blocking` is every task this one depends on that is not done.
 */
export function evaluateStartCheck(input: { requirementLinked: boolean; blocking: { title: string; status: string }[] }): TaskStartCheck {
  const open = input.blocking.length;
  const named = [...input.blocking]
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, NAMED)
    .map((t) => `"${t.title}" (${t.status.replace(/_/g, ' ')})`)
    .join(', ');
  const reason = !input.requirementLinked
    ? START_REQUIREMENT_MESSAGE
    : open > 0
      ? `Dependency check failed: waiting on ${named}${open > NAMED ? ` and ${open - NAMED} more` : ''}. Finish ${open === 1 ? 'it' : 'them'} first, or remove the dependency.`
      : null;
  return { startable: reason === null, requirementOk: input.requirementLinked, openDependencies: open, reason };
}
