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

  /**
   * Whether this agent may decide that somebody else's work is complete.
   *
   * ADM-82 answers it for the whole roster in one sentence: **"QA is the
   * independent verifier and no other agent may declare another agent's work
   * complete."** The same decision names the prohibition twice, because the
   * tempting violation is specific — *"THE ORCHESTRATOR MUST NOT judge
   * completion, act as QA, override QA, or certify delivery."*
   *
   * Declared here rather than left as prose, because `verdictFor` checks that
   * a verifier is the producer's DECLARED verifier — and a definition writing
   * `verifiedBy: 'orchestrator'` would satisfy that check while breaking the
   * rule it exists to enforce. The runtime check asks whether the right agent
   * is speaking; this asks whether that agent was ever allowed to.
   */
  readonly mayVerify: boolean;

  readonly verification: {
    /**
     * Always `false`, and typed as the literal so it cannot be otherwise.
     * ADM-82: no agent may declare another agent's work complete, and none
     * may declare its own.
     */
    readonly selfAssertionAllowed: false;
    readonly requiredEvidence: readonly EvidenceKind[];
    /**
     * Never this agent's own key, and never an agent whose `mayVerify` is
     * false. Both checked at build time by check-record §14.
     */
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
 * `verifiedBy` is 'quality_assurance' since F4: the verification contract cannot be exercised
 * at all without a defined verifier, and this agent cannot be its own. Until
 * F4 it was null, which was the honest value while no verifier existed.
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
  handoffTargets: ['quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: ['requirement'],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/**
 * `qa` — the verifier, defined so the contract can exist.
 *
 * ADM-82 makes QA the only agent that may decide whether work is done, and no
 * other agent may declare another's work complete. That rule needs somebody to
 * *be* the verifier before it means anything: `verdictFor` refuses a verdict
 * from an undefined agent, so with no QA definition the contract could not be
 * exercised even in a test.
 *
 * **Defined, and seeded disabled.** A definition is not an activation — the
 * distinction F1 established and ADM-82 requires, since it granted which
 * agents exist and withheld implementation. QA gives verdicts through the
 * verification contract rather than through a tool, so it needs no tools to be
 * defined, and `enabled = false` keeps activation a separate decision.
 *
 * `verifiedBy` is null and not something else: nothing verifies the verifier.
 * That is not an omission — ADM-83 made QA's rejection final as a verdict, and
 * a chain of verifiers verifying verifiers has no end and no extra safety.
 */
const QA: AgentDefinition = {
  key: 'quality_assurance',
  displayName: 'QA',
  layer: 'foundation',
  purpose:
    'Decides whether submitted work amounts to completion. Rejects a claim that lacks evidence, and may not write the work it reviews.',
  capabilities: ['reasoning', 'long_context'],
  tools: [],
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: [],
  // The one true value on the roster. ADM-82 gives this authority to QA and
  // withholds it from everybody else, by name.
  mayVerify: true,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: null,
  },
  retry: { maxAttempts: 1, onExhausted: 'escalate' },
};

/**
 * Every agent AgencyOS can run.
 *
 * A key here is not an activation: `ai.agents.enabled` decides that, per
 * organization. A key *missing* from here, on an enabled row, is a build
 * failure — that is the rule G-125 exists to establish.
 */
/**
 * `orchestrator` — layer 1, and the agent ADM-82 constrains most tightly.
 *
 * *"The orchestrator is system-level — routing, context assembly, handoffs,
 * workflow coordination."* And immediately after, in capitals:
 * **"THE ORCHESTRATOR MUST NOT judge completion, act as QA, override QA, or
 * certify delivery."**
 *
 * `mayVerify: false` is that sentence, expressed where it can be checked
 * rather than read. Without it, a later definition writing
 * `verifiedBy: 'orchestrator'` would pass `verdictFor` — which asks whether
 * the *declared* verifier is speaking, not whether that agent was ever
 * entitled to be declared.
 *
 * `handoffTargets` is empty, deliberately. Routing is what this agent does, so
 * a filled list is eventually correct — but the targets are the agents it
 * routes to, and ADM-82 activates those in layers 2 and 3. Naming them now
 * would be inventing a graph the documents do not specify; an empty list means
 * no handoff can be created at all, which is the same honest state QA has held
 * since F3.
 */
const ORCHESTRATOR: AgentDefinition = {
  key: 'orchestrator',
  displayName: 'Orchestrator',
  layer: 'foundation',
  purpose:
    'Routes work to the responsible agent, assembles the context it needs, and coordinates handoffs. Decides nothing about whether work is complete.',
  capabilities: ['reasoning', 'structured_output', 'long_context'],
  tools: [],
  // Document 08 §19: the orchestrator should not expose internal routing
  // details to clients. Nothing it produces is client-facing.
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: [],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  // Document 03 §20: RETRY → ALTERNATIVE STRATEGY → ESCALATION. Two attempts
  // is the route and one alternative; a third would be guessing.
  retry: { maxAttempts: 2, onExhausted: 'escalate' },
};

/**
 * `developer` — layer 1, and the producer QA exists to check.
 *
 * Document 13 §24 states the engineering Definition of Done, and two of its
 * items are evidence a verifier can demand: *"Relevant tests pass. Required
 * build succeeds."* Those are `requiredEvidence` here, so a claim of
 * completion that brings neither is rejected by the contract rather than by
 * somebody noticing.
 *
 * The handoff to QA is the one edge three documents state independently —
 * Document 03 §9 (*"DEVELOPER WORKFLOW → QA HANDOFF"*), Document 13 §31
 * (*"DEVELOPER → STRUCTURED HANDOFF → QA"*) and Document 23 §28
 * (*"Developer Agent → QA Agent: Build artifact + commit + test evidence"*).
 * It is declared because it is documented, not because it would be convenient.
 *
 * Defined, not activated. ADM-82 granted the roster and withheld
 * implementation; there is no developer workflow, no repository binding and no
 * tool. What this buys today is that the verification contract has a second
 * producer to be exercised against, and that the mirrors carry more than one
 * pair.
 */
const DEVELOPER: AgentDefinition = {
  key: 'developer',
  displayName: 'Developer',
  layer: 'foundation',
  purpose:
    'Implements approved scope in controlled tasks and submits evidence of it. Never decides that its own work is done.',
  capabilities: ['coding', 'reasoning', 'long_context'],
  tools: [],
  // Document 08 §19: developer agents should not overwhelm clients with
  // internal technical detail. Work reaches a client through the PM, not here.
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: ['tests', 'build'],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  REQUIREMENT_COLLECTOR,
  ORCHESTRATOR,
  DEVELOPER,
  QA,
];

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
