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
 * **L2 — autonomous within limits. Still refused on this path, and the reason
 * has changed.**
 *
 * It used to say no policy existed. **ADM-61 states one**, and in detail: at L2
 * an agent may break down *already-approved* requirements, plan and update
 * internal work, and draft anything; it must bring anything client-facing or
 * touching money to the internal group; and it may never invent a price,
 * promise a date it was not given, or write a client credential.
 *
 * Read against that list, this path is still refused — and now for a stated
 * reason rather than an absent one. Autonomy here would mean the agent
 * **accepting its own requirement proposal**, which is not among the things
 * ADM-61 permits without asking. Nor is it internal work: an accepted
 * requirement version is the scope a quotation is built against (G-011 §12),
 * so it reaches a client through the price that follows it.
 *
 * Silently treating L2 as L1 would still be worse than refusing: an operator
 * who sets L2 expecting autonomy would get none and be told nothing.
 *
 * What G-101 now records is narrower than it was: **no caller uses the
 * permissions ADM-61 does grant.** The breakdown it names is `G-020`'s
 * `break_down_requirement`, which a human invokes. Building an action
 * permission model before an agent exists to use one would be machinery with
 * no caller.
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
      // Names the policy and says which clause refuses this, so an operator is
      // told the rule rather than told there isn't one. It used to say "has no
      // defined behaviour", which stopped being true when ADM-61 was answered.
      reason:
        'agent is L2 (autonomous within limits, ADM-61), and this path is outside those limits — ' +
        'accepting its own requirement proposal is not among the actions L2 permits without asking, ' +
        'and the accepted version is the scope a quotation is built against, so it reaches a client (G-101)',
    };
  }

  return { allowed: false, reason: `agent autonomy level "${level}" is not recognised` };
}
