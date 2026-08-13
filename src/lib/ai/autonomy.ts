/**
 * What an agent is allowed to do, read from its own row — gap G-041.
 *
 * `ai.agents.autonomy_level` has existed since the schema was written, with a
 * comment saying exactly what the levels mean: *L0 read-only · L1 propose
 * (requires approval) · L2 autonomous within limits.* The job runner selected
 * the column and then ignored it — worse than not selecting it, because the
 * code read as though autonomy were configurable while the behaviour was L1
 * whatever the row said. Changing an agent's autonomy was a deploy.
 *
 * Pure and dependency-free, like `jobs/staleness.ts`: the decision is worth
 * testing on its own, and the thing that executes it holds a service-role
 * client a test has no business holding. The database enforces the same rule
 * independently — `ai.agent_runs_autonomy_guard` — so a caller that skips this
 * check is refused rather than obeyed.
 */

export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export type AutonomyVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether this agent may perform work that writes.
 *
 * **L0 — read-only.** Refused. An L0 agent that ran anyway would make the
 * level decorative, and the point of the column is that somebody can stop an
 * agent with an UPDATE rather than a release.
 *
 * **L1 — propose.** Allowed. Everything this system's one agent does already
 * ends in something a human accepts or rejects: an extraction writes a
 * `proposed` requirement version and stops.
 *
 * **L2 — autonomous.** Refused, and this is the one worth explaining. For the
 * extraction path, autonomous would mean the agent accepting its own proposal
 * with no human — exactly what directive §29 forbids without a stated policy,
 * and no such policy exists. Silently treating L2 as L1 would be worse than
 * refusing: an operator who sets L2 expecting autonomy would get none and be
 * told nothing. Recorded as G-101, with the decision it waits on.
 *
 * An unrecognised level is refused rather than defaulted. A typo in a row must
 * not quietly grant the ability to write.
 */
export function mayAgentRun(level: string): AutonomyVerdict {
  if (level === 'L1') return { allowed: true };

  if (level === 'L0') {
    return { allowed: false, reason: 'agent is L0 (read-only) and may not perform work' };
  }

  if (level === 'L2') {
    return {
      allowed: false,
      reason:
        'agent is L2 (autonomous), which has no defined behaviour on this path — ' +
        'accepting its own proposal needs a stated policy (G-101)',
    };
  }

  return { allowed: false, reason: `agent autonomy level "${level}" is not recognised` };
}
