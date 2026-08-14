import { err, ok, type Result } from '@/lib/result';

/**
 * The ceilings that stop an agent running away — gaps G-133 and G-134.
 *
 * The application half of a rule the database also enforces, which is
 * ARCHITECTURE §8.1's shape: the service refuses, and the database refuses
 * again so a second caller cannot skip the check by not knowing about it.
 *
 * ── what was actually wrong ───────────────────────────────────────────────
 *
 * `ai.agents.max_steps` and `max_cost_minor` were seeded per agent, carried
 * CHECK constraints and were documented. `ai.agent_runs` recorded `step_count`
 * and `cost_minor` faithfully. **Nothing compared the two**, and
 * `ai.agent_runs.budget_exceeded` — a terminal status named for exactly this —
 * had never been set by anything.
 *
 * Stated plainly rather than dressed up: this was not a live defect. The one
 * enabled agent makes a single model call, so `step_count` is always 1 and no
 * ceiling could be reached. It becomes a defect the moment any agent takes a
 * second step.
 *
 * ── why the check is before the step, not after ───────────────────────────
 *
 * The database trigger catches an overspend once it is recorded, which is the
 * backstop. This is asked *before* spending, which is the only place a limit
 * can prevent rather than merely report. A ceiling enforced only after the
 * fact is an audit trail, not a ceiling.
 */

export type Ceilings = {
  /** `ai.agents.max_steps`. */
  readonly maxSteps: number;
  /** `ai.agents.max_cost_minor`, in minor units. */
  readonly maxCostMinor: number;
};

export type Used = {
  readonly steps: number;
  readonly costMinor: number;
};

/**
 * Whether an agent may take another step.
 *
 * Asked with what has *already* been spent. The next step's cost is unknown
 * before it is taken — a model call's price is not knowable in advance — so
 * this refuses once the ceiling is reached rather than predicting the step
 * that would cross it. Erring toward one step over budget is the honest
 * limitation, and the database records the true figure either way.
 */
export function mayContinue(used: Used, ceilings: Ceilings): Result<void> {
  if (used.steps >= ceilings.maxSteps) {
    return err(
      'FORBIDDEN',
      `step ceiling reached: ${used.steps} of ${ceilings.maxSteps}. The run stops here rather than asking what the next step would have found.`,
    );
  }

  if (used.costMinor >= ceilings.maxCostMinor) {
    return err(
      'FORBIDDEN',
      `cost ceiling reached: ${used.costMinor} of ${ceilings.maxCostMinor} minor units.`,
    );
  }

  return ok(undefined);
}

/** The bound on how long one correlation chain of handoffs may run — G-134. */
export const MAX_HANDOFF_DEPTH = 8;

/**
 * Whether a handoff may be created at this depth.
 *
 * The database derives the depth itself and ignores what a caller passes,
 * because a derived value a caller may override is a suggestion rather than a
 * bound — and the caller here is an agent. This is the readable half: it lets
 * a service decline before writing, and say why.
 *
 * `A → B → A → B` satisfies every other rule recorded: each hop a declared
 * target, each agent within its autonomy, each step audited. Nothing but a
 * depth bound distinguishes that from progress, because it *produces* new
 * handoffs, new runs and new steps the whole time it runs.
 */
export function mayHandOffAtDepth(currentDepth: number): Result<void> {
  if (currentDepth >= MAX_HANDOFF_DEPTH) {
    return err(
      'FORBIDDEN',
      `handoff refused: depth ${currentDepth} of ${MAX_HANDOFF_DEPTH}. A chain this long is a loop, not progress.`,
    );
  }
  return ok(undefined);
}
