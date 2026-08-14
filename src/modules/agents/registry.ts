/**
 * The agent registry — G-125, decisions ADM-82 and ADM-83.
 *
 * `ARCHITECTURE.md` §6.2 has named this file since the architecture was
 * written, and until now it did not exist. That absence is half of G-125: the
 * other half is that `supabase/seed.sql` registers three agents while the job
 * runner can reach exactly one, so an Admin reading `ai.agents` sees three
 * working agents and has one.
 *
 * ── two halves that must agree ────────────────────────────────────────────
 *
 * An agent is defined twice on purpose, and `check-record` §14 proves the two
 * halves match:
 *
 *   this file      what an agent IS — capabilities, tools, authority, who
 *                  verifies it. Architectural, reviewable in a diff. A
 *                  capability change should be visible in a pull request and
 *                  not in an UPDATE nobody sees.
 *
 *   ai.agents      how it is DEPLOYED — enabled, autonomy, model, ceilings.
 *                  Operational, per organization, changeable without a deploy.
 *
 * The rule binding them: **an enabled row whose key has no definition here
 * cannot run, and the build fails.**
 *
 * ── the forbidden states are not expressible ──────────────────────────────
 *
 * ADM-82 lists authority rules and ADM-83 requires them to be structural
 * rather than advisory. Three of them are enforced by the type system below,
 * which is stronger than a check: a definition that breaks them does not
 * compile, so the failure arrives while somebody is writing it rather than
 * when CI runs.
 *
 *   - `moneyAuthority` has no 'decides' member. ADM-22 and business rules
 *     08 §5.1 forbid an agent inventing a price at any level and state that
 *     approval does not cure it, so the type cannot say it.
 *   - `selfAssertionAllowed` is the literal `false`, not `boolean`. No
 *     definition can set it true. It exists as a field only so a reader finds
 *     the rule where they would look for it.
 *   - `verifiedBy` may not be the agent's own key — ADM-82's producer ≠
 *     verifier rule, checked at build time.
 *
 * ── what is deliberately not here yet ─────────────────────────────────────
 *
 * Only `requirement_collector` is defined, because it is the only agent that
 * exists: one code path, one AGENT_KEY, one working extraction. The other
 * twelve ADM-82 approved are defined when their tools exist — a definition
 * naming tools nothing implements would be the same defect this file was
 * written to remove, told in TypeScript instead of in seed data.
 *
 * Activation is a separate decision. ADM-82 granted *which* agents exist and
 * explicitly withheld implementation, so a definition appearing here is not
 * permission to enable anything.
 */

/** Where an agent sits in ADM-82's activation order. */
export type AgentLayer = 'foundation' | 'core' | 'operations';

/**
 * What an agent may attempt, declared rather than inferred.
 *
 * Capabilities are matched against the model registry (ADM-84) so an agent
 * never names a vendor. Kept deliberately small: a capability nothing routes
 * on is a word, not a constraint.
 */
export type AgentCapability =
  | 'reasoning'
  | 'coding'
  | 'long_context'
  | 'structured_output'
  | 'multimodal';

/**
 * Money authority.
 *
 * **There is no `'decides'`.** ADM-22: *"There is no price catalog. Every
 * price is quoted per client, by a human."* Business rules 08 §5.1 makes it
 * absolute — *"They do not become permissible at a higher autonomy level"* —
 * so an approval-gated pricing agent is not a safer version of a forbidden
 * one, it is the forbidden one with a queue in front.
 */
export type MoneyAuthority = 'none' | 'proposes_for_approval';

/** Evidence a verifier may demand before a claim of completion is a verdict. */
export type EvidenceKind =
  | 'typecheck'
  | 'lint'
  | 'tests'
  | 'live'
  | 'record'
  | 'build'
  | 'requirement'
  | 'approval';

export type AgentDefinition = {
  /** Matches `ai.agents.key`. */
  readonly key: string;
  readonly displayName: string;
  readonly layer: AgentLayer;
  readonly purpose: string;

  readonly capabilities: readonly AgentCapability[];

  /**
   * The authorization set. A tool absent from this list is not bound to the
   * agent, so a model asking for it is asking for something that does not
   * exist — which is what makes prompt injection survivable rather than
   * merely detectable.
   *
   * Empty until the tool layer exists (F2). An empty list is honest: this
   * agent currently reaches the model through the one hard-coded path in the
   * job runner and calls no tools at all.
   */
  readonly tools: readonly string[];

  /**
   * True when anything this agent produces can reach a client.
   *
   * Consent-gated under ADM-70 and the applicable communication policy —
   * **not automatically approval-gated**, because ADM-11 permits certain
   * automated follow-ups with nobody reading them first. Consent and approval
   * are different controls and this flag selects neither on its own.
   */
  readonly clientFacing: boolean;

  readonly moneyAuthority: MoneyAuthority;

  /** The only agents this one may hand work to. Enforced in the DB at F3. */
  readonly handoffTargets: readonly string[];

  readonly verification: {
    /**
     * Always `false`, and typed as the literal so it cannot be otherwise.
     * ADM-82: no agent may declare another agent's work complete, and none
     * may declare its own.
     */
    readonly selfAssertionAllowed: false;
    readonly requiredEvidence: readonly EvidenceKind[];
    /** Never this agent's own key. Checked at build time by §14. */
    readonly verifiedBy: string | null;
  };

  readonly retry: {
    readonly maxAttempts: number;
    readonly onExhausted: 'escalate';
  };
};

/**
 * `requirement_collector` — the only agent that exists.
 *
 * Seeded since the first day and reachable through `AGENT_KEY` in
 * `app/api/jobs/run/route.ts`. It reads a conversation and proposes a
 * structured requirement version; a human sends anything a client sees, which
 * is what makes it L1 under ADM-61 rather than L2.
 *
 * `verifiedBy` is null rather than 'qa': the QA agent does not exist, and
 * naming a verifier that cannot verify would be a claim about the system that
 * is not true. It becomes 'qa' when QA exists (F5), and §14 refuses a
 * definition that verifies itself whatever is written there.
 */
const REQUIREMENT_COLLECTOR: AgentDefinition = {
  key: 'requirement_collector',
  displayName: 'Requirement Collector',
  layer: 'foundation',
  purpose:
    'Reads a lead conversation and proposes a structured requirement version. Proposes; a human sends.',
  capabilities: ['reasoning', 'long_context', 'structured_output'],
  tools: [],
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: [],
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: ['requirement'],
    verifiedBy: null,
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/**
 * Every agent AgencyOS can run.
 *
 * A key here is not an activation: `ai.agents.enabled` decides that, per
 * organization. A key *missing* from here, on an enabled row, is a build
 * failure — that is the rule G-125 exists to establish.
 */
export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [REQUIREMENT_COLLECTOR];

export const AGENT_KEYS: readonly string[] = AGENT_DEFINITIONS.map((a) => a.key);

/** The definition for a key, or null when the key is not defined here. */
export function definitionFor(key: string): AgentDefinition | null {
  return AGENT_DEFINITIONS.find((a) => a.key === key) ?? null;
}

/**
 * Whether an agent may hand work to another — ADM-83.
 *
 * The receiver must be an allowed target in the **sender's** definition, which
 * makes the handoff graph an authorization boundary rather than a routing
 * convenience: an agent cannot reach one it has no declared relationship with,
 * even by naming it. Enforced in the database at F3; this is the same rule the
 * application answers with.
 */
export function mayHandOff(from: string, to: string): boolean {
  if (from === to) return false;
  return definitionFor(from)?.handoffTargets.includes(to) ?? false;
}
