import { createHash } from 'node:crypto';

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
export type AgentLayer = 'foundation' | 'core' | 'operations' | 'acquisition' | 'development' | 'qa';

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
  // ADM-114: the QA Orchestrator routes the Phase 6 test work to its specialists. A route hands work over and grants nothing; QA stays the only
  // agent that may decide whether work is complete, and the Admin alone approves a release candidate.
  handoffTargets: [
    'functional_test', 'ui_journey_test', 'api_integration_test', 'database_test', 'security_test', 'performance_test',
    'compatibility_test', 'regression_test', 'release_readiness',
  ],
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
 * The acquisition agents: the owner's decision of 2026-10-05, from the Lead
 * Generation & Acquisition Implementation Specification (section 12 of the PDF).
 *
 * ADM-82's roster of thirteen was closed, so these are a NEW grant, recorded as
 * ADM-112. The specification names four: Ad Manager (one agent for Meta and
 * Google, platform strategy kept separate), Email Marketing Outreach, Social
 * Media Marketing and B2B Opportunity. Scheduler and Quotation Master are
 * shared and already exist as the meeting and quotation subtasks, so they are
 * not agents here. The landing page belongs to the Ad Manager, as the
 * specification says, and is not a fifth agent.
 *
 * **Defined and installed DISABLED**, like ADM-82's own grant: a definition is
 * not an activation. Two things stand between these agents and real work, and
 * both are the owner's: a funded model key, and a decision under ADM-99 to
 * dispatch the draft-creating tools (today only the four read-only tools
 * dispatch, and these agents' write tools are bound and authorizable but have
 * no dispatch handler). Until then they are honest about what they are.
 *
 * What they can never do is expressed by what they cannot reach: no tool sends,
 * publishes, launches, deploys, prices, approves or pauses anything. Every one
 * of those is a governed door a person (or a policy) opens.
 */

/** `ad_manager` - one agent for Meta and Google Ads, platform-specific strategy kept apart. */
const AD_MANAGER: AgentDefinition = {
  key: 'ad_manager',
  displayName: 'Ad Manager',
  layer: 'acquisition',
  purpose:
    'Audits past ad results, drafts Meta and Google campaign versions and the Google landing page, and watches results against qualified leads. Launches nothing and changes no budget.',
  capabilities: ['reasoning', 'long_context', 'structured_output'],
  tools: [
    'acquisition.readResults',
    'ads.readCampaigns',
    'ads.draftCampaign',
    'ads.checkCampaign',
    'ads.submitCampaign',
    'landing.draftPage',
    'landing.checkPage',
    'landing.submitPage',
    'memory.recall',
    'memory.remember',
  ],
  // Nothing it holds sends, publishes, launches or deploys. The engines do
  // that, as governed once-only executions behind exact-version approval, so
  // what reaches a person outside is a property of the engine and not of
  // anything this agent can call.
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['sales', 'quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `email_outreach` - Prospect, Qualify, Outreach, Reply, Nurture. Meeting and quotation requests go through the shared subtasks; a move to WhatsApp goes through a tracked handoff to `sales`. */
const EMAIL_OUTREACH: AgentDefinition = {
  key: 'email_outreach',
  displayName: 'Email Outreach',
  layer: 'acquisition',
  purpose:
    'Researches and scores prospects against the ICP, drafts personalised outreach from recorded facts and checks it. Sends nothing: a campaign sends through the governed path.',
  capabilities: ['reasoning', 'long_context', 'structured_output'],
  tools: [
    'acquisition.readResults',
    'email.readProspects',
    'email.scoreProspect',
    'email.recordProspectFact',
    'email.checkDraft',
    'memory.recall',
    'memory.remember',
    'crm.addLeadNote',
  ],
  // Nothing it holds sends, publishes, launches or deploys. The engines do
  // that, as governed once-only executions behind exact-version approval, so
  // what reaches a person outside is a property of the engine and not of
  // anything this agent can call.
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['sales', 'quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `social_media` - organic content and social prospecting for LinkedIn, Instagram and Facebook; each platform audited and planned separately. */
const SOCIAL_MEDIA: AgentDefinition = {
  key: 'social_media',
  displayName: 'Social Media',
  layer: 'acquisition',
  purpose:
    'Plans content from the strategy, drafts versions with an objective and runs the review. Publishes nothing: a version publishes only when approved exactly as written.',
  capabilities: ['reasoning', 'long_context', 'structured_output', 'multimodal'],
  tools: [
    'acquisition.readResults',
    'social.readContentQueue',
    'social.draftContent',
    'social.reviewContent',
    'social.submitContent',
    'memory.recall',
    'memory.remember',
  ],
  // Nothing it holds sends, publishes, launches or deploys. The engines do
  // that, as governed once-only executions behind exact-version approval, so
  // what reaches a person outside is a property of the engine and not of
  // anything this agent can call.
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['sales', 'quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `marketplace_opportunity` - Upwork, Freelancer, PeoplePerHour, Guru, Contra, Fiverr; Clutch and GoodFirms profile work. A person prices every proposal (ADM-22). */
const MARKETPLACE_OPPORTUNITY: AgentDefinition = {
  key: 'marketplace_opportunity',
  displayName: 'B2B Opportunity',
  layer: 'acquisition',
  purpose:
    'Scores marketplace opportunities, rejects low fit and drafts tailored proposals from the real opportunity and approved agency evidence. Prices nothing and submits nothing.',
  capabilities: ['reasoning', 'long_context', 'structured_output'],
  tools: [
    'acquisition.readResults',
    'marketplace.readOpportunities',
    'marketplace.scoreOpportunity',
    'marketplace.draftProposal',
    'marketplace.checkProposal',
    'marketplace.submitProposal',
    'memory.recall',
    'memory.remember',
  ],
  // Nothing it holds sends, publishes, launches or deploys. The engines do
  // that, as governed once-only executions behind exact-version approval, so
  // what reaches a person outside is a property of the engine and not of
  // anything this agent can call.
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['sales', 'quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
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
  // ADM-113: the Orchestrator routes approved development tasks to the specialists. A route is not authority: it hands work over, it
  // never approves, verifies or widens a tool.
  handoffTargets: [
    'frontend_developer', 'backend_developer', 'database_developer', 'mobile_developer', 'integration', 'devops_build',
    'test_automation', 'security_review', 'bug_fix', 'refactor_performance', 'documentation',
  ],
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

/**
 * Layers 2 and 3 — the nine ADM-82 grants and withholds.
 *
 * Each is DISABLED in the database. ADM-82 granted which agents exist and
 * withheld their implementation; a definition is not an activation, and
 * Phase 5 remains a separate decision. What a definition buys before then is
 * that every boundary in this module — tool authorization, the handoff graph,
 * the verification contract — is exercised against the roster it will actually
 * have, rather than against the two agents that happened to exist first.
 *
 * Tools are bound from what AgencyOS already implements. An agent naming a
 * capability nothing provides is a registry defect `resolveTool` reports as
 * one, so the lists below are short on purpose: they are what exists, not what
 * the documents eventually want.
 */

/** `sales` — one agent, not three. ADM-82 folded qualification, requirement
 *  collection, proposal drafting, follow-up, objection handling and
 *  negotiation support into it, "kept MODULAR INTERNALLY so they can be split
 *  later if scale justifies it".
 *
 *  It is the only agent here that is client-facing, and the only one whose
 *  forbidden action needs restating: it may draft the scope and timeline of a
 *  quotation and it may never state a price. There is no pricing tool for it
 *  to hold — ADM-22 as an absence rather than a rule it could break. */
const SALES: AgentDefinition = {
  key: 'sales',
  displayName: 'Sales',
  layer: 'core',
  purpose:
    'Answers a lead, qualifies it, discovers requirements, handles objections and drafts the quotation whole — scope and proposed prices from the agency’s own corpus (ADM-96). No price reaches a client until a human decides it.',
  capabilities: ['reasoning', 'long_context', 'structured_output'],
  tools: [
    'crm.readLead',
    'crm.readConversation',
    'memory.recall',
    'memory.remember',
    'crm.addLeadNote',
    'crm.recordSalesActivity',
    'sales.draftProposal',
    'approvals.requestApproval',
    'crm.sendClientMessage',
  ],
  clientFacing: true,
  // Not 'proposes_for_approval'. ADM-22 permits no agent pricing at any level,
  // and approval does not make it permissible (business rules 08 §5.1).
  moneyAuthority: 'none',
  handoffTargets: ['project_manager', 'quality_assurance', 'customer_success'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: ['requirement'],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `project_manager` — project-level, and ADM-82 draws the line from the
 *  orchestrator sharply: planning, decomposition, assignment, dependencies,
 *  monitoring, blockers, coordination, INITIATING QA, escalation.
 *
 *  Initiating QA is not performing it. It hands work to the verifier and does
 *  not become one. */
const PROJECT_MANAGER: AgentDefinition = {
  key: 'project_manager',
  displayName: 'Project Manager',
  layer: 'core',
  purpose:
    'Plans and sequences a project, coordinates the specialists, tracks blockers and initiates QA. Judges no work complete.',
  capabilities: ['reasoning', 'long_context', 'structured_output'],
  tools: [
    'projects.readScope',
    'memory.recall',
    'memory.remember',
    'projects.submitChangeRequest',
    'approvals.requestApproval',
    'crm.sendClientMessage',
  ],
  clientFacing: true,
  moneyAuthority: 'none',
  handoffTargets: ['ui_designer', 'developer', 'quality_assurance', 'project_planning'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `project_planning` — Phase 2 Planning §1: how the PROJECT is organised and
 *  moves through AgencyOS, never how the PRODUCT is built. It drafts the
 *  operational blueprint (deliverables, phase sequence, dependencies, risks,
 *  readiness gates) from the accepted scope; a person approves it. It does not
 *  talk to the client - the project manager owns communication, so any
 *  question it has goes to the PM - and it holds no money authority: finance
 *  gates are mapped onto the sequence from the payment plan, never decided. */
const PROJECT_PLANNING: AgentDefinition = {
  key: 'project_planning',
  displayName: 'Project Planning',
  layer: 'core',
  purpose:
    'Turns the accepted scope into the operational project blueprint - deliverables, phase sequence, dependencies, risks and readiness gates. Plans how the project moves through AgencyOS, never how the product is built. Drafts; a person approves.',
  capabilities: ['reasoning', 'long_context', 'structured_output'],
  tools: ['projects.readScope', 'memory.recall'],
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['project_manager'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `ui_designer` — designs from the approved scope, not from the last message.
 *  That distinction is why Doc 11's baseline had to exist first. */
const UI_DESIGNER: AgentDefinition = {
  key: 'ui_designer',
  displayName: 'UI Designer',
  layer: 'core',
  purpose:
    'Designs the screens the approved scope requires, and files them as a versioned deliverable for review.',
  capabilities: ['multimodal', 'reasoning', 'long_context'],
  tools: ['projects.readScope', 'memory.recall', 'projects.addDeliverable'],
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['ui_prototype', 'quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `ui_prototype` — ADM-82 keeps delivery at three agents "because the
 *  documented project lifecycle separates design -> prototype -> build, and
 *  deliverables.kind carries exactly those". */
const UI_PROTOTYPE: AgentDefinition = {
  key: 'ui_prototype',
  displayName: 'Prototype',
  layer: 'core',
  purpose:
    'Turns an approved design into something a client can actually use, and files the build for review.',
  capabilities: ['coding', 'reasoning', 'multimodal'],
  tools: ['projects.readScope', 'memory.recall', 'projects.addDeliverable'],
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['developer', 'quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: ['build'],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `handover` — accepted by ADM-82 as a separate agent for one reason, stated
 *  there: it "must not be the same authority that produced what it certifies".
 *  It consumes QA evidence, production readiness, approved deliverables,
 *  client approval, deployment state and package state — and must never expose
 *  secrets, which is why it holds no credential tool and never will. */
const HANDOVER: AgentDefinition = {
  key: 'handover',
  displayName: 'Handover',
  layer: 'core',
  purpose:
    'Assembles the handover package from evidence others produced, and never exposes a credential.',
  capabilities: ['reasoning', 'long_context'],
  tools: ['projects.readScope', 'memory.recall', 'approvals.requestApproval'],
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['customer_success'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: ['approval'],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 2, onExhausted: 'escalate' },
};

/** `finance` — generates invoices from approved milestones and never verifies
 *  a payment. Doc 15 §23: "Never mark a milestone paid from a client message
 *  alone." Verification is a human act, and there is no tool here for it. */
const FINANCE: AgentDefinition = {
  key: 'finance',
  displayName: 'Finance',
  layer: 'operations',
  purpose:
    'Generates invoices from approved milestones and tracks what is outstanding. Verifies no payment.',
  capabilities: ['structured_output', 'reasoning'],
  tools: ['memory.recall', 'finance.generateInvoice', 'approvals.requestApproval'],
  clientFacing: false,
  // The one agent that touches money at all, and it still proposes rather than
  // decides: an invoice is generated from terms a human already accepted.
  moneyAuthority: 'proposes_for_approval',
  handoffTargets: ['quality_assurance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: ['approval'],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 3, onExhausted: 'escalate' },
};

/** `support` — answers what is asked and classifies what is reported. Doc 17
 *  §19 draws the line it must not cross: a new feature is not a warranty bug,
 *  and calling one the other is how unpaid scope arrives. */
const SUPPORT: AgentDefinition = {
  key: 'support',
  displayName: 'Support',
  layer: 'operations',
  purpose:
    'Answers client questions from approved knowledge and classifies what is reported. Never reclassifies new work as warranty.',
  capabilities: ['reasoning'],
  tools: ['crm.readConversation', 'memory.recall', 'qa.raiseDefect', 'crm.sendClientMessage'],
  clientFacing: true,
  moneyAuthority: 'none',
  handoffTargets: ['developer', 'quality_assurance', 'customer_success', 'sales'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 2, onExhausted: 'escalate' },
};

/** `customer_success` — watches the relationship after delivery. Doc 18 §35:
 *  never fabricate satisfaction, never invent usage, never claim a client is
 *  VIP without configured criteria. Its memory writes are inferences, and the
 *  memory table will not let them be anything else. */
const CUSTOMER_SUCCESS: AgentDefinition = {
  key: 'customer_success',
  displayName: 'Customer Success',
  layer: 'operations',
  purpose:
    'Tracks a completed client relationship from recorded signals and prepares check-ins. Fabricates no satisfaction.',
  capabilities: ['reasoning', 'long_context'],
  tools: ['memory.recall', 'memory.remember', 'crm.addLeadNote', 'crm.sendClientMessage'],
  clientFacing: true,
  moneyAuthority: 'none',
  handoffTargets: ['sales', 'support', 'finance'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 2, onExhausted: 'escalate' },
};

/** `upsell` — ADM-82 is blunt about this one, in capitals: **"UPSELL HAS ZERO
 *  PRICING AUTHORITY: it may identify and recommend internally and must never
 *  invent a price, calculate a quote, offer a discount, negotiate price or
 *  make a commercial commitment."**
 *
 *  So it is NOT client-facing, holds no message tool, and hands what it finds
 *  to sales. The prohibition is expressed by what it cannot reach rather than
 *  by a sentence in its prompt. */
const UPSELL: AgentDefinition = {
  key: 'upsell',
  displayName: 'Upsell',
  layer: 'operations',
  purpose:
    'Identifies a legitimate expansion opportunity from recorded facts and tells the team. Contacts no client and never names a price.',
  capabilities: ['reasoning'],
  tools: ['memory.recall', 'memory.remember', 'crm.addLeadNote'],
  clientFacing: false,
  moneyAuthority: 'none',
  handoffTargets: ['sales'],
  mayVerify: false,
  verification: {
    selfAssertionAllowed: false,
    requiredEvidence: [],
    verifiedBy: 'quality_assurance',
  },
  retry: { maxAttempts: 2, onExhausted: 'escalate' },
};

/**
 * The Phase 5 development specialists: the owner's Phase 5 specification (eleven agents) - granted by ADM-113, installed DISABLED.
 *
 * Definition is not activation. None of them holds a tool today: the code they would write, the builds they would run and the reviews they
 * would record all go through governed doors a person (or QA) opens, and nothing here can merge, deploy to production, approve or verify.
 * Every one is verified by `quality_assurance` and no other agent; `security_review` REVIEWS (a record with an independent reviewer) but does
 * not hold verification authority - ADM-82 gives that to QA alone. What they cannot reach is the point: no agent here reaches a client,
 * money, a payment, or production.
 */
function developmentSpecialist(input: {
  verifiedBy?: 'quality_assurance';
  key: string;
  displayName: string;
  purpose: string;
  capabilities: readonly AgentCapability[];
  handoffTargets: readonly string[];
  requiredEvidence: readonly EvidenceKind[];
}): AgentDefinition {
  return {
    key: input.key,
    displayName: input.displayName,
    layer: 'development',
    purpose: input.purpose,
    capabilities: input.capabilities,
    tools: [],
    clientFacing: false,
    moneyAuthority: 'none',
    handoffTargets: input.handoffTargets,
    mayVerify: false,
    verification: { selfAssertionAllowed: false, requiredEvidence: input.requiredEvidence, verifiedBy: 'quality_assurance' },
    retry: { maxAttempts: 3, onExhausted: 'escalate' },
  };
}

const FRONTEND_DEVELOPER = developmentSpecialist({
  key: 'frontend_developer',
  displayName: 'Frontend Developer',
  purpose: 'Implements the exact client-approved UI version and prototype: screens, states, forms, accessibility. No silent redesign.',
  capabilities: ['coding', 'reasoning', 'long_context'],
  handoffTargets: ['quality_assurance', 'security_review'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['typecheck', 'lint', 'tests', 'build'],
});
const BACKEND_DEVELOPER = developmentSpecialist({
  key: 'backend_developer',
  displayName: 'Backend / API Developer',
  purpose: 'Implements authoritative business logic, APIs and server actions that trace to approved requirements. Never redefines scope.',
  capabilities: ['coding', 'reasoning', 'long_context'],
  handoffTargets: ['quality_assurance', 'security_review'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['typecheck', 'lint', 'tests', 'build'],
});
const DATABASE_DEVELOPER = developmentSpecialist({
  key: 'database_developer',
  displayName: 'Database Developer',
  purpose: 'Writes schema, constraints, RLS and migrations. Never rewrites migration history, never weakens RLS to make a feature work.',
  capabilities: ['coding', 'reasoning', 'long_context'],
  handoffTargets: ['quality_assurance', 'security_review'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['tests', 'live', 'record'],
});
const MOBILE_DEVELOPER = developmentSpecialist({
  key: 'mobile_developer',
  displayName: 'Mobile Developer',
  purpose: 'Implements the approved mobile UI on Flutter / Android / iOS. NOT_REQUIRED for a web-only project; never fabricates a device test.',
  capabilities: ['coding', 'reasoning', 'long_context', 'multimodal'],
  handoffTargets: ['quality_assurance', 'security_review'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['tests', 'build'],
});
const INTEGRATION = developmentSpecialist({
  key: 'integration',
  displayName: 'Integration Agent',
  purpose: 'Connects approved external services through canonical adapters. CONFIGURED is not VERIFIED; a mock success is not a real integration.',
  capabilities: ['coding', 'reasoning', 'structured_output'],
  handoffTargets: ['quality_assurance', 'security_review'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['tests', 'live'],
});
const DEVOPS_BUILD = developmentSpecialist({
  key: 'devops_build',
  displayName: 'DevOps / Build Agent',
  purpose: 'Runs the development build system: environment checks, builds, artifacts with source traceability. No production deployment in Phase 5.',
  capabilities: ['coding', 'reasoning'],
  handoffTargets: ['quality_assurance'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['build'],
});
const TEST_AUTOMATION = developmentSpecialist({
  key: 'test_automation',
  displayName: 'Test Automation Agent',
  purpose: 'Writes and runs unit, API, database, integration and E2E tests and records machine-readable results. Automated green is not independent QA pass.',
  capabilities: ['coding', 'reasoning', 'structured_output'],
  handoffTargets: ['quality_assurance'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['tests'],
});
const SECURITY_REVIEW = developmentSpecialist({
  key: 'security_review',
  displayName: 'Security & Code Review Agent',
  purpose: 'Reviews the exact commit independently of whoever wrote it: auth, RLS, tenancy, secrets, injection. Records findings; verification authority stays with QA.',
  capabilities: ['reasoning', 'long_context'],
  handoffTargets: ['quality_assurance'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['record'],
});
const BUG_FIX = developmentSpecialist({
  key: 'bug_fix',
  displayName: 'Bug Fix Agent',
  purpose: 'Reproduces a defect, finds the root cause and makes the minimal fix. Produces FIX_READY only; QA verifies. Never closes its own defect.',
  capabilities: ['coding', 'reasoning', 'long_context'],
  handoffTargets: ['quality_assurance', 'security_review'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['tests', 'build'],
});
const REFACTOR_PERFORMANCE = developmentSpecialist({
  key: 'refactor_performance',
  displayName: 'Refactoring & Performance Agent',
  purpose: 'Conditional: only for approved technical debt or a measured performance problem; baseline first, before-and-after measurement, no functional change.',
  capabilities: ['coding', 'reasoning', 'long_context'],
  handoffTargets: ['quality_assurance', 'security_review'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['tests', 'build'],
});
const DOCUMENTATION = developmentSpecialist({
  key: 'documentation',
  displayName: 'Documentation Agent',
  purpose: 'Keeps implementation-derived documentation current and builds the Phase 6 QA intake. Documents what exists; never what is planned, never a secret.',
  capabilities: ['reasoning', 'long_context', 'structured_output'],
  handoffTargets: ['quality_assurance'],
  verifiedBy: 'quality_assurance',
  requiredEvidence: ['record'],
});


/**
 * The Phase 6 QA specialists - ADM-114, installed DISABLED. The QA Orchestrator of the specification IS `quality_assurance` (ADM-82's one verifier);
 * no second orchestrator is created. These produce TEST EVIDENCE; none of them can declare work complete, approve a candidate, record an exception,
 * verify a payment or deploy anything, and none holds a tool today. QA Independence: creator != validator is enforced in the database for every
 * result they would record (the person or agent that produced the build cannot record its result).
 */
function qaSpecialist(input: { verifiedBy?: 'quality_assurance'; key: string; displayName: string; purpose: string; capabilities: readonly AgentCapability[]; handoffTargets: readonly string[] }): AgentDefinition {
  return {
    key: input.key,
    displayName: input.displayName,
    layer: 'qa',
    purpose: input.purpose,
    capabilities: input.capabilities,
    tools: [],
    clientFacing: false,
    moneyAuthority: 'none',
    handoffTargets: input.handoffTargets,
    mayVerify: false,
    verification: { selfAssertionAllowed: false, requiredEvidence: ['tests'], verifiedBy: 'quality_assurance' },
    retry: { maxAttempts: 2, onExhausted: 'escalate' },
  };
}
const FUNCTIONAL_TEST = qaSpecialist({ key: 'functional_test', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'Functional Test Agent', purpose: 'Verifies features, business rules and acceptance criteria against the exact release candidate. Does not fix.', capabilities: ['reasoning', 'long_context', 'structured_output'] });
const UI_E2E_TEST = qaSpecialist({ key: 'ui_journey_test', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'UI / E2E Test Agent', purpose: 'Tests the approved UI and the critical user journeys end to end. A preference is not a defect unless the approved UI supports it.', capabilities: ['reasoning', 'long_context', 'structured_output', 'multimodal'] });
const API_INTEGRATION_TEST = qaSpecialist({ key: 'api_integration_test', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'API / Integration Test Agent', purpose: 'Tests API contracts and integrations. Configured is not verified; a mock success is not a provider verification.', capabilities: ['reasoning', 'long_context', 'structured_output'] });
const DATABASE_TEST = qaSpecialist({ key: 'database_test', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'Database Test Agent', purpose: 'Tests schema, constraints, RLS, tenant isolation, migrations and transactions. Never destructive against production.', capabilities: ['reasoning', 'long_context', 'structured_output'] });
const SECURITY_TEST = qaSpecialist({ key: 'security_test', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'Security Test Agent', purpose: 'Independent security and permission validation. Raw exploit detail never reaches a client-facing view.', capabilities: ['reasoning', 'long_context', 'structured_output'] });
const PERFORMANCE_TEST = qaSpecialist({ key: 'performance_test', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'Performance Test Agent', purpose: 'Measures against project-specific targets and records the method and environment. Never invents a universal threshold.', capabilities: ['reasoning', 'long_context', 'structured_output'] });
const COMPATIBILITY_TEST = qaSpecialist({ key: 'compatibility_test', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'Compatibility / Device Test Agent', purpose: 'Tests the declared browser/device matrix. A simulator is not a device; one browser is not all browsers; an unavailable target is BLOCKED, never a pass.', capabilities: ['reasoning', 'long_context', 'structured_output'] });
const REGRESSION_TEST = qaSpecialist({ key: 'regression_test', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'Regression Test Agent', purpose: 'Targeted, expanded and full relevant regression and escaped-defect protection. Flaky is not a pass.', capabilities: ['reasoning', 'long_context', 'structured_output'] });
const RELEASE_READINESS = qaSpecialist({ key: 'release_readiness', handoffTargets: ['quality_assurance'], verifiedBy: 'quality_assurance', displayName: 'Release / Production Readiness Agent', purpose: 'Freezes the exact candidate, evaluates the gates and readiness, prepares exception requests and the Phase 7 intake. Approves nothing, deploys nothing.', capabilities: ['reasoning', 'long_context', 'structured_output'] });

/**
 * The Phase 9 finance agents - ADM-115, installed DISABLED. The Finance Agent of the specification IS `finance`; these three are the reviewable
 * identities for responsibilities it does not hold: reconciliation findings, payment-reminder DRAFTS and close-readiness notes. Each holds no tool, none
 * can verify a payment, change an amount, issue a refund, decide a waiver, close a book or message a client (`moneyAuthority: 'none'`), and each PROPOSES
 * into a record a person accepts or rejects (creator != reviewer, in the database).
 */
function financeSpecialist(input: { key: string; displayName: string; purpose: string; handoffTargets: readonly ['finance']; verifiedBy: 'quality_assurance' }): AgentDefinition {
  return {
    key: input.key,
    displayName: input.displayName,
    layer: 'operations',
    purpose: input.purpose,
    capabilities: ['reasoning', 'structured_output'],
    tools: [],
    clientFacing: false,
    moneyAuthority: 'none',
    handoffTargets: [...input.handoffTargets],
    mayVerify: false,
    verification: { selfAssertionAllowed: false, requiredEvidence: ['record'], verifiedBy: input.verifiedBy },
    retry: { maxAttempts: 2, onExhausted: 'escalate' },
  };
}
const FINANCE_RECONCILIATION = financeSpecialist({ key: 'finance_reconciliation', handoffTargets: ['finance'], verifiedBy: 'quality_assurance', displayName: 'Finance Reconciliation Agent', purpose: 'Compares what AgencyOS recorded with what the project and period books show and proposes findings and anomaly flags with evidence. Rewrites nothing, verifies nothing.' });
const FINANCE_COMMUNICATION = financeSpecialist({ key: 'finance_communication', handoffTargets: ['finance'], verifiedBy: 'quality_assurance', displayName: 'Finance Communication Agent', purpose: 'Drafts payment reminders and payment-status messages from the invoice\'s real outstanding balance. Drafts only: never sends, never promises a discount, waiver, refund or deferral.' });
const FINANCE_CLOSE = financeSpecialist({ key: 'finance_close', handoffTargets: ['finance'], verifiedBy: 'quality_assurance', displayName: 'Finance Close Agent', purpose: 'Reads a project\'s financial position and proposes close-readiness notes and exception classifications. Closes nothing; the close is a person\'s act.' });

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  // Foundation — ADM-82 layer 1
  REQUIREMENT_COLLECTOR,
  ORCHESTRATOR,
  DEVELOPER,
  QA,
  // Core — layer 2
  SALES,
  PROJECT_MANAGER,
  PROJECT_PLANNING,
  UI_DESIGNER,
  UI_PROTOTYPE,
  HANDOVER,
  // Operations — layer 3
  FINANCE,
  SUPPORT,
  CUSTOMER_SUCCESS,
  UPSELL,
  // Acquisition - ADM-112
  AD_MANAGER,
  EMAIL_OUTREACH,
  SOCIAL_MEDIA,
  MARKETPLACE_OPPORTUNITY,
  // Development specialists - ADM-113 (Phase 5)
  FRONTEND_DEVELOPER,
  BACKEND_DEVELOPER,
  DATABASE_DEVELOPER,
  MOBILE_DEVELOPER,
  INTEGRATION,
  DEVOPS_BUILD,
  TEST_AUTOMATION,
  SECURITY_REVIEW,
  BUG_FIX,
  REFACTOR_PERFORMANCE,
  DOCUMENTATION,
  // QA specialists - ADM-114 (Phase 6)
  FUNCTIONAL_TEST,
  UI_E2E_TEST,
  API_INTEGRATION_TEST,
  DATABASE_TEST,
  SECURITY_TEST,
  PERFORMANCE_TEST,
  COMPATIBILITY_TEST,
  REGRESSION_TEST,
  RELEASE_READINESS,
  // Finance additions - ADM-115 (Phase 9)
  FINANCE_RECONCILIATION,
  FINANCE_COMMUNICATION,
  FINANCE_CLOSE,
  // Phase 7 production launch agents (P704-P706), installed DISABLED. Reused, not duplicated: project_manager, orchestrator, finance, handover, customer_success.
  // Each hands off only to QA; none verifies, approves a deployment, declares ProductionValidated, edits source in production or holds a tool.
  {
    key: 'deployment_agent', displayName: 'Deployment Agent', layer: 'operations', clientFacing: false, moneyAuthority: 'none', tools: [],
    purpose: 'Deploys the exact Admin-approved Phase 6 candidate to production with validated configuration, migrations and rollback controls. Never approves its own deployment and never declares ProductionValidated.',
    capabilities: ['coding', 'reasoning'], handoffTargets: ['quality_assurance'], mayVerify: false,
    verification: { selfAssertionAllowed: false, requiredEvidence: ['build'], verifiedBy: 'quality_assurance' }, retry: { maxAttempts: 2, onExhausted: 'escalate' },
  },
  {
    key: 'release_qa', displayName: 'QA / Release Agent', layer: 'qa', clientFacing: false, moneyAuthority: 'none', tools: [],
    purpose: 'Independently validates the exact deployed candidate in production: smoke, live critical flows, monitoring and rollback verification. A deployment claim is not production validation.',
    capabilities: ['reasoning', 'long_context', 'structured_output'], handoffTargets: ['quality_assurance'], mayVerify: false,
    verification: { selfAssertionAllowed: false, requiredEvidence: ['live'], verifiedBy: 'quality_assurance' }, retry: { maxAttempts: 2, onExhausted: 'escalate' },
  },
  {
    key: 'incident_recovery', displayName: 'Production Incident and Recovery Agent', layer: 'operations', clientFacing: false, moneyAuthority: 'none', tools: [],
    purpose: 'Coordinates production incidents, controlled rollback and recovery for the exact release. Completion stays paused until recovery is verified.',
    capabilities: ['reasoning', 'long_context'], handoffTargets: ['quality_assurance'], mayVerify: false,
    verification: { selfAssertionAllowed: false, requiredEvidence: ['record'], verifiedBy: 'quality_assurance' }, retry: { maxAttempts: 2, onExhausted: 'escalate' },
  },
];

export const AGENT_KEYS: readonly string[] = AGENT_DEFINITIONS.map((a) => a.key);

/**
 * A stable fingerprint of what the registry currently declares.
 *
 * `ai.agents.definition_version` records which revision a live row was last
 * validated against, and `last_validated_at` when. Both were NULL on every
 * production row, because the only thing that wrote them was
 * `scripts/verify-agent-definitions.mjs` — and that script targets the
 * verification database by design, never production. The columns ADM-83 added
 * to make drift visible had no producer where drift actually happens, and the
 * Agents page showed every agent as **"never"** validated.
 *
 * Derived from the definitions rather than from the file's bytes, for two
 * reasons. A runtime cannot reliably read its own source once bundled, so a
 * file hash cannot be computed in production at all. And a comment edit is not
 * a definition change: hashing prose would invalidate every stamp for a
 * reworded docblock, which trains a reader to ignore the field.
 *
 * Serialised field by field rather than through `JSON.stringify` on the whole
 * object: property order would then decide the hash, and a future refactor
 * that reorders a literal would look like a definition change.
 */
export function registryRevision(): string {
  return revisionOf(AGENT_DEFINITIONS);
}

/**
 * The same fingerprint over any roster.
 *
 * Exported so the properties can be proved rather than asserted: that changing
 * a field changes the revision, and that reordering the array — or the strings
 * inside a definition — does not. `registryRevision()` is this over the real
 * roster, and nothing else computes one.
 */
export function revisionOf(definitions: readonly AgentDefinition[]): string {
  const canonical = definitions.map((a) =>
    [
      a.key,
      a.layer,
      a.displayName,
      a.purpose,
      [...a.capabilities].sort().join('+'),
      [...a.tools].sort().join('+'),
      String(a.clientFacing),
      a.moneyAuthority,
      [...a.handoffTargets].sort().join('+'),
      String(a.mayVerify),
      String(a.verification.selfAssertionAllowed),
      [...a.verification.requiredEvidence].sort().join('+'),
      a.verification.verifiedBy ?? '-',
      String(a.retry.maxAttempts),
      a.retry.onExhausted,
    ].join('|'),
  )
    .slice()
    .sort()
    .join('\n');

  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}


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
