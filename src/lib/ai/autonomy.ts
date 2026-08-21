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
/**
 * What kind of work a task is, in ADM-61's own vocabulary.
 *
 * `docs/business-os/08-ai-agent-responsibilities.md` §2 lists what an L2 agent
 * may do alone and §3 lists what it must bring to the internal group. The two
 * lists are the whole of the distinction, so they are the whole of this type.
 *
 * §2 — alone:
 *   `breakdown`      break approved requirements into modules, features and
 *                    tasks. Automatic by ADM-16, not proposed for review.
 *   `internal_plan`  plan, schedule, re-order and update internal work.
 *   `draft`          draft anything at all: messages, proposals, summaries.
 *   `read`           read anything its organization can read.
 *
 * §3 — must ask:
 *   `client_facing`     anything that reaches a client, follow-ups excepted.
 *   `money`             a price, an invoice, a refund, a payment confirmation.
 *   `delivery_approval` UI designs, prototypes, builds, QA and production-ready
 *                       sign-off.
 *
 * **Drafting a thing and approving it are different work**, and that is the
 * distinction this type exists to carry. Producing a design is `draft`;
 * approving it is `delivery_approval`. Extracting a requirement into a
 * *proposed* version is `draft`; accepting that version is not on §2's list at
 * all — which is exactly what the old level-only gate was reaching for and
 * could not express.
 */
export const WORK_CLASSES = [
  'read',
  'draft',
  'internal_plan',
  'breakdown',
  'client_facing',
  'money',
  'delivery_approval',
] as const;

export type WorkClass = (typeof WORK_CLASSES)[number];

/** §2. Everything not here needs the internal group, including a typo. */
const ALONE_AT_L2: readonly string[] = ['read', 'draft', 'internal_plan', 'breakdown'];

/** §3, with the clause that refuses each — an operator is told the rule. */
const MUST_ASK: Record<string, string> = {
  client_facing:
    'it reaches a client, and ADM-61 §3 requires anything that reaches a client to come to the ' +
    'internal group first (the ADM-11 follow-ups are the single exception)',
  money:
    'it touches money — a price, an invoice, a refund or a payment confirmation — which ADM-61 §3 ' +
    'requires to come to the internal group first',
  delivery_approval:
    'it is a delivery approval, and ADM-61 §3 names UI designs, prototypes, builds, QA and ' +
    'production-ready sign-off as approvals the internal group gives',
};

/**
 * May this agent perform THIS work?
 *
 * The level alone was never enough, and saying so was the last thing G-101 was
 * waiting on. This function used to take one argument, so every L2 agent was
 * refused by an argument written about one path — requirement extraction, where
 * autonomy would have meant the agent accepting its own proposal. That argument
 * is still right about extraction and was never right about the other six L2
 * agents, which the function had no way to tell apart.
 *
 * **Nothing that runs today changes.** Every current workflow is L1, and L1 is
 * allowed for every class, exactly as before. What changes is that the gate can
 * now express ADM-61 instead of approximating it.
 *
 * The work class is required rather than defaulted. A caller that forgets it is
 * refused, for the same reason an unrecognised level is: a gap must not quietly
 * grant the ability to act.
 */
export function mayAgentRun(level: string, work: string): AutonomyVerdict {
  if (!(WORK_CLASSES as readonly string[]).includes(work)) {
    return {
      allowed: false,
      reason: `work class "${work}" is not recognised, so no autonomy level can permit it`,
    };
  }

  // §5's five absolutes are not represented here on purpose. They are not
  // things a level or a class permits — they are refused in the database and in
  // the absence of any tool that could do them, so a gate that appeared to
  // adjudicate them would suggest a level at which they became allowed.

  if (level === 'L1') return { allowed: true };

  if (level === 'L0') {
    return { allowed: false, reason: 'agent is L0 (read-only) and may not perform work' };
  }

  if (level === 'L2') {
    if (ALONE_AT_L2.includes(work)) return { allowed: true };
    return {
      allowed: false,
      reason: `agent is L2 (autonomous within limits, ADM-61), and ${MUST_ASK[work]}`,
    };
  }

  return { allowed: false, reason: `agent autonomy level "${level}" is not recognised` };
}
