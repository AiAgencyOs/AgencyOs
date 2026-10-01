/**
 * Owner decision Q-C3 — Start Task is gated by two checks (SCR-041, "one-task-at-a-time
 * execution surface enforcing requirement check, dependency check, ...").
 *
 *   requirement check  the task is linked to a requirement version, or to a feature that
 *                      carries an included or optional scope item;
 *   dependency check   the project's newest plan has no dependency still pending, requested
 *                      or blocked (received and not-applicable are complete).
 *
 * The database says it in `projects.task_start_check` and refuses in `projects.start_task`
 * (`no_requirement`, `dependencies_open`); this module is the same sentences, so the button
 * and the response name the failing reason. Pure: no server-only imports.
 */

export const START_REQUIREMENT_MESSAGE =
  'Requirement check failed: this task is not linked to a requirement or scope item. Link it to the feature that delivers one, or ask the requirement on the task page.';

export const START_DEPENDENCY_MESSAGE =
  'Dependency check failed: a dependency is still outstanding on the project plan. Mark it supplied or not applicable first.';

export type TaskStartCheck = {
  startable: boolean;
  requirementOk: boolean;
  openDependencies: number;
  /** The sentence the button shows when the task cannot start; null when it can. */
  reason: string | null;
};

/** The pure rule, for the sentence and for tests: the same two checks, in the same order. */
export function evaluateStartCheck(input: { requirementLinked: boolean; openDependencies: number }): TaskStartCheck {
  const open = Math.max(0, Math.trunc(input.openDependencies));
  const reason = !input.requirementLinked
    ? START_REQUIREMENT_MESSAGE
    : open > 0
      ? `Dependency check failed: ${open} ${open === 1 ? 'dependency is' : 'dependencies are'} still outstanding on the project plan. Mark them supplied or not applicable first.`
      : null;
  return { startable: reason === null, requirementOk: input.requirementLinked, openDependencies: open, reason };
}
