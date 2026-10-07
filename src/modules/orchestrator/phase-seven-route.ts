import { AGENT_DEFINITIONS, definitionFor, mayHandOff, registryRevision } from '@/modules/agents/registry';

/**
 * Phase 7 (Production Launch and Handover) routing: the Orchestrator's decision for a deployment, validation, incident or handover task (P703), as PURE
 * functions. The facts (is the agent enabled, is the plan's Admin approval still valid, did an Admin approve the rollback) are passed in, so the same rule
 * serves the job handler and the tests, and the database door (`projects.record_phase_seven_routing`) refuses a decision these rules forbid.
 *
 * The Orchestrator ROUTES. It approves no deployment, validates no production, closes no incident and grants no tool. Three outcomes are honest, none is a
 * failure: HELD (the agent is disabled, holds no tool, or the gate for the task is not met: the reason is stated), REFUSED (no route exists, the project has
 * completed, a code defect is not a retry) and EVENT_HANDLED (the PM and Finance act through their event handlers and database doors, not through an agent
 * handoff). Every Phase 7 agent is installed disabled and holds NO tool, so today every agent-bound task is HELD; this is the state the build proves.
 *
 * Production tools need production credentials (an owner binding: docs/phase-7-manual-actions.md P7-M001/P7-M008). A task that needs one is held with
 * `tool_not_bound` until the registry binds it to the agent AND an Admin has granted the elevated permission for that exact plan.
 */

export const PHASE_SEVEN_TASK_TYPES = [
  'deployment_execution',
  'readiness_review',
  'smoke_validation',
  'health_check',
  'incident_triage',
  'rollback_coordination',
  'client_update',
  'financial_clearance_review',
] as const;
export type PhaseSevenTaskType = (typeof PHASE_SEVEN_TASK_TYPES)[number];

type Owner = { agent: string; via: 'agent' | 'event_handler' };

/** Who owns each task type. Validation is never the deployer's (validator != deployer): `release_qa` owns every check; `deployment_agent` owns none of them. */
export const TASK_OWNER: Record<PhaseSevenTaskType, Owner> = {
  deployment_execution: { agent: 'deployment_agent', via: 'agent' },
  readiness_review: { agent: 'deployment_agent', via: 'agent' },
  smoke_validation: { agent: 'release_qa', via: 'agent' },
  health_check: { agent: 'release_qa', via: 'agent' },
  incident_triage: { agent: 'incident_recovery', via: 'agent' },
  rollback_coordination: { agent: 'incident_recovery', via: 'agent' },
  client_update: { agent: 'project_manager', via: 'event_handler' },
  financial_clearance_review: { agent: 'finance', via: 'event_handler' },
};

/** The tools a task would need. None of these is bound to any Phase 7 agent today (the registry gives them `tools: []`). */
export const TASK_TOOLS: Record<PhaseSevenTaskType, readonly string[]> = {
  deployment_execution: ['deploy_artifact', 'run_migration'],
  readiness_review: ['read_readiness'],
  smoke_validation: ['run_smoke_check'],
  health_check: ['read_health'],
  incident_triage: ['read_incident'],
  rollback_coordination: ['rollback_deployment'],
  client_update: [],
  financial_clearance_review: [],
};

/** Tools that act on production. They need the elevated permission: a registry binding AND an Admin grant for the exact plan. Never a model's request. */
export const PRODUCTION_TOOLS: ReadonlySet<string> = new Set(['deploy_artifact', 'run_migration', 'rollback_deployment', 'run_smoke_check']);

export type RouteCandidate = { agent: string; eligible: boolean; rejected: string | null };

export type PhaseSevenRoute =
  | { outcome: 'routed'; code: 'routed'; toAgent: string; reason: string; candidates: RouteCandidate[]; missingTools: readonly string[] }
  | {
      outcome: 'held';
      code: 'phase_seven_not_active' | 'plan_not_approved' | 'rollback_not_approved' | 'agent_disabled' | 'tool_not_bound' | 'elevated_permission_missing';
      toAgent: string;
      reason: string;
      candidates: RouteCandidate[];
      missingTools: readonly string[];
    }
  | { outcome: 'event_handled'; code: 'event_handler'; toAgent: string; reason: string; candidates: RouteCandidate[]; missingTools: readonly string[] }
  | { outcome: 'refused'; code: 'unknown_task' | 'project_completed' | 'no_route'; toAgent: null; reason: string; candidates: RouteCandidate[]; missingTools: readonly string[] };

export type PhaseSevenFacts = {
  /** `ai.agents.enabled` by key. */
  enabled: ReadonlyMap<string, boolean>;
  /** The workspace's state (`projects.phase_seven.state`); null when the project is not in the pipeline. */
  workspaceState: string | null;
  /** deployment_execution: does the plan's Admin approval still hold for the current candidate (`p7_deployment_approved`)? */
  planApproved?: boolean | null;
  /** rollback_coordination: did an Admin approve a rollback for this incident? */
  rollbackApproved?: boolean | null;
  /** Elevated production permissions an Admin has granted for this exact plan (none exists today). */
  elevatedGrants?: ReadonlySet<string>;
  /** The tools bound to an agent. Defaults to the registry; injectable so the rule can be exercised for an agent an owner has equipped. */
  toolsFor?: (agent: string) => readonly string[];
};

const COMPLETED = new Set(['completed', 'phase8_ready']);
const AGENT_KEYS = ['deployment_agent', 'release_qa', 'incident_recovery'] as const;

export function isPhaseSevenTaskType(value: string): value is PhaseSevenTaskType {
  return (PHASE_SEVEN_TASK_TYPES as readonly string[]).includes(value);
}

function candidatesFor(owner: Owner, facts: PhaseSevenFacts): RouteCandidate[] {
  return AGENT_KEYS.map((key) => {
    if (key !== owner.agent) return { agent: key, eligible: false, rejected: 'another specialist owns this task type' };
    if (!mayHandOff('orchestrator', key)) return { agent: key, eligible: false, rejected: 'no declared route from the Orchestrator' };
    if (facts.enabled.get(key) !== true) return { agent: key, eligible: false, rejected: 'installed but not enabled' };
    return { agent: key, eligible: true, rejected: null };
  });
}

export function decidePhaseSevenRoute(taskType: string, facts: PhaseSevenFacts): PhaseSevenRoute {
  if (!isPhaseSevenTaskType(taskType)) {
    return { outcome: 'refused', code: 'unknown_task', toAgent: null, reason: `${taskType} is not a Phase 7 task type`, candidates: [], missingTools: [] };
  }
  const owner = TASK_OWNER[taskType];
  const needs = TASK_TOOLS[taskType];

  // The PM and Finance are not routed to: the PM announces through its event handlers (PM7 templates) and Finance through its database doors.
  if (owner.via === 'event_handler') {
    return { outcome: 'event_handled', code: 'event_handler', toAgent: owner.agent, reason: `${owner.agent} acts through its own event handlers and database doors, not through an agent handoff`, candidates: [], missingTools: [] };
  }
  const candidates = candidatesFor(owner, facts);
  if (facts.workspaceState === null) {
    return { outcome: 'held', code: 'phase_seven_not_active', toAgent: owner.agent, reason: 'the project is not in the Phase 7 pipeline', candidates, missingTools: needs };
  }
  // a completed project never returns to production work (new work is a change request or a new project)
  if (COMPLETED.has(facts.workspaceState)) {
    return { outcome: 'refused', code: 'project_completed', toAgent: null, reason: 'the project is completed: new work is a change request or a new project, never production work on the completed one', candidates, missingTools: needs };
  }
  if (!mayHandOff('orchestrator', owner.agent)) {
    return { outcome: 'refused', code: 'no_route', toAgent: null, reason: `the Orchestrator has no declared route to ${owner.agent}`, candidates, missingTools: needs };
  }
  // the gate for the task, from the database's own facts
  if (taskType === 'deployment_execution' && facts.planApproved !== true) {
    return { outcome: 'held', code: 'plan_not_approved', toAgent: owner.agent, reason: 'no Admin approval holds for the current candidate: a deployment is never routed on an approval that is stale or missing', candidates, missingTools: needs };
  }
  if (taskType === 'rollback_coordination' && facts.rollbackApproved !== true) {
    return { outcome: 'held', code: 'rollback_not_approved', toAgent: owner.agent, reason: 'an Admin has not approved a rollback for this incident: a rollback is controlled, never blind', candidates, missingTools: needs };
  }
  if (facts.enabled.get(owner.agent) !== true) {
    return { outcome: 'held', code: 'agent_disabled', toAgent: owner.agent, reason: `${owner.agent} is installed but not enabled; the task waits rather than pretending to run`, candidates, missingTools: needs };
  }
  const bound = facts.toolsFor ? facts.toolsFor(owner.agent) : (definitionFor(owner.agent)?.tools ?? []);
  const unbound = needs.filter((t) => !bound.includes(t));
  if (unbound.length > 0) {
    return { outcome: 'held', code: 'tool_not_bound', toAgent: owner.agent, reason: `${owner.agent} holds no tool for ${unbound.join(', ')}: production tools need credentials and a registry binding (an owner decision)`, candidates, missingTools: unbound };
  }
  const elevated = needs.filter((t) => PRODUCTION_TOOLS.has(t) && !facts.elevatedGrants?.has(t));
  if (elevated.length > 0) {
    return { outcome: 'held', code: 'elevated_permission_missing', toAgent: owner.agent, reason: `an Admin has not granted the elevated production permission for ${elevated.join(', ')} on this plan`, candidates, missingTools: elevated };
  }
  return { outcome: 'routed', code: 'routed', toAgent: owner.agent, reason: `${owner.agent} owns this task type and every gate for it holds`, candidates, missingTools: [] };
}

/** Whether an agent may call a tool for a task right now. The registry binding is the ceiling; a production tool also needs the Admin grant. Never a prompt's say-so. */
export function authorizePhaseSevenTool(input: { agent: string; tool: string; grants?: ReadonlySet<string> }): { allowed: boolean; reason: string } {
  const def = definitionFor(input.agent);
  if (!def) return { allowed: false, reason: `${input.agent} is not a registered agent` };
  if (!def.tools.includes(input.tool)) return { allowed: false, reason: `${input.tool} is not bound to ${input.agent} in the registry` };
  if (PRODUCTION_TOOLS.has(input.tool) && !input.grants?.has(input.tool)) return { allowed: false, reason: `${input.tool} acts on production and needs an Admin-granted elevated permission` };
  return { allowed: true, reason: 'bound in the registry' + (PRODUCTION_TOOLS.has(input.tool) ? ' and granted by an Admin' : '') };
}

/** The same failure classes as development (`handleExecutionFailure`), with the Phase 7 caps: a deployment side effect is never blindly retried. */
export type Phase7Failure = 'transient_provider_error' | 'timeout' | 'rate_limit' | 'tool_failure' | 'invalid_output' | 'side_effect_uncertain' | 'permission_denied' | 'policy_block' | 'deployment_failed' | 'validation_failed';
export type Phase7Handling = { retry: 'safe' | 'after_reconcile' | 'never'; escalate: boolean; reason: string };

export function phaseSevenRetryPolicy(taskType: PhaseSevenTaskType, failure: Phase7Failure, attempt: number): Phase7Handling {
  const max = Math.min(definitionFor(TASK_OWNER[taskType].agent)?.retry.maxAttempts ?? 1, taskType === 'deployment_execution' || taskType === 'rollback_coordination' ? 1 : 2);
  const exhausted = attempt >= max;
  switch (failure) {
    case 'permission_denied':
    case 'policy_block':
      return { retry: 'never', escalate: true, reason: 'a refusal is never retried and never worked around' };
    case 'side_effect_uncertain':
    case 'deployment_failed':
      // production may or may not have changed: reconcile against the deployment record, then a person decides
      return { retry: 'after_reconcile', escalate: true, reason: 'production may have changed: reconcile against the deployment record before anything is repeated' };
    case 'validation_failed':
      return { retry: 'never', escalate: true, reason: 'a failed production check opens an incident and pauses completion; it is not retried into a pass' };
    default:
      // a transient failure BEFORE any production effect, within the bound
      return exhausted ? { retry: 'never', escalate: true, reason: 'the retry budget is spent' } : { retry: 'safe', escalate: false, reason: 'repeating cannot repeat a production side effect' };
  }
}

/** Failure routing (P703 §9): infrastructure/config go to the Deployment agent; a code defect never goes back through a deploy retry. */
export function routePhaseSevenFailure(incidentPath: 'unclassified' | 'config' | 'code' | 'provider' | 'rollback'):
  | { route: 'incident_recovery'; task: PhaseSevenTaskType; reason: string }
  | { route: 'deployment_agent'; task: PhaseSevenTaskType; reason: string }
  | { route: 'new_candidate_required'; task: null; reason: string } {
  switch (incidentPath) {
    case 'config':
    case 'provider':
      return { route: 'deployment_agent', task: 'readiness_review', reason: 'an infrastructure or configuration failure is recovered on the SAME candidate and re-validated' };
    case 'rollback':
      return { route: 'incident_recovery', task: 'rollback_coordination', reason: 'a rollback is coordinated against the Admin-approved decision and re-validated' };
    case 'code':
      return { route: 'new_candidate_required', task: null, reason: 'a code defect needs a new governed candidate and every Phase 6 gate: it is never retried as a deployment' };
    default:
      return { route: 'incident_recovery', task: 'incident_triage', reason: 'an unclassified incident is triaged before any recovery is chosen' };
  }
}

/** Phase 7 events as routable work (P703 §13). */
export function taskTypeForEvent(eventType: string): PhaseSevenTaskType | null {
  switch (eventType) {
    case 'project.deployment_approved':
      return 'deployment_execution';
    case 'project.deployment_failed':
    case 'project.production_validation_failed':
      return 'incident_triage';
    default:
      return null;
  }
}

/** The policy a decision was made under: the registry revision. */
export function phaseSevenPolicyVersion(): string {
  return `registry-${registryRevision()}`;
}

export const PHASE_SEVEN_FORBIDDEN_ACTIONS: readonly string[] = [
  'approve its own deployment or any plan',
  'declare production validated',
  'deploy a candidate other than the Admin-approved one',
  'edit source in production',
  'write a secret value into a log, record or message',
  'close an incident without a verified recovery',
  'accept a handover on the client\'s behalf',
  'verify a payment or declare project completion',
];

export type PhaseSevenEnvelope = {
  taskType: PhaseSevenTaskType;
  organizationId: string;
  projectId: string;
  destination: string;
  intent: string;
  subjectId: string | null;
  planId: string | null;
  candidate: { commitRef: string | null; artifactSha256: string | null };
  environment: 'production';
  toolPermissions: readonly string[];
  elevatedPermissions: readonly string[];
  forbiddenActions: readonly string[];
  requiredEvidence: readonly string[];
  independentVerifier: string;
  timeoutSeconds: number;
  retryBudget: number;
  idempotencyKey: string;
  attempt: number;
  routingReason: string;
  specialistRevision: string;
};

export function buildPhaseSevenEnvelope(input: {
  taskType: PhaseSevenTaskType;
  organizationId: string;
  projectId: string;
  subjectId?: string | null;
  planId?: string | null;
  candidate?: { commitRef: string | null; artifactSha256: string | null };
  routingReason: string;
  attempt?: number;
  elevatedGrants?: ReadonlySet<string>;
}): PhaseSevenEnvelope {
  const owner = TASK_OWNER[input.taskType];
  const def = definitionFor(owner.agent);
  return {
    taskType: input.taskType,
    organizationId: input.organizationId,
    projectId: input.projectId,
    destination: owner.agent,
    intent: `Phase 7 task: ${input.taskType.replace(/_/g, ' ')}`,
    subjectId: input.subjectId ?? null,
    planId: input.planId ?? null,
    candidate: input.candidate ?? { commitRef: null, artifactSha256: null },
    environment: 'production',
    // exactly what the REGISTRY binds to the agent: a model asking for more is asking for something that does not exist
    toolPermissions: def ? [...def.tools] : [],
    elevatedPermissions: [...(input.elevatedGrants ?? [])].filter((t) => PRODUCTION_TOOLS.has(t) && (def?.tools.includes(t) ?? false)),
    forbiddenActions: PHASE_SEVEN_FORBIDDEN_ACTIONS,
    requiredEvidence: def ? [...def.verification.requiredEvidence] : [],
    // creator != validator: QA verifies an agent's work and a person approves what changes production
    independentVerifier: def?.verification.verifiedBy ?? 'a person',
    timeoutSeconds: input.taskType === 'deployment_execution' ? 1800 : 900,
    retryBudget: Math.min(def?.retry.maxAttempts ?? 1, input.taskType === 'deployment_execution' || input.taskType === 'rollback_coordination' ? 1 : 2),
    idempotencyKey: `${input.taskType}:${input.subjectId ?? input.planId ?? input.projectId}:${input.attempt ?? 1}`,
    attempt: input.attempt ?? 1,
    routingReason: input.routingReason,
    specialistRevision: registryRevision(),
  };
}

/** An incomplete or unsafe envelope is REJECTED, not repaired. */
export function validatePhaseSevenEnvelope(e: PhaseSevenEnvelope): string[] {
  const problems: string[] = [];
  const owner = TASK_OWNER[e.taskType];
  const def = definitionFor(e.destination);
  if (!e.organizationId || !e.projectId) problems.push('the envelope does not name its organization and project');
  if (!owner || owner.agent !== e.destination || owner.via !== 'agent') problems.push('the destination does not own this task type');
  if (!def) problems.push('the destination is not a registered agent');
  if (e.taskType === 'deployment_execution') {
    if (!e.planId) problems.push('a deployment envelope names its approved plan');
    if (!e.candidate.commitRef || !e.candidate.artifactSha256) problems.push('a deployment envelope names the exact commit and artifact');
  }
  if (e.environment !== 'production') problems.push('a Phase 7 envelope targets production explicitly');
  if (e.forbiddenActions.length === 0) problems.push('the envelope carries no forbidden-action list');
  if (e.requiredEvidence.length === 0) problems.push('the envelope names no required evidence');
  if (e.retryBudget < 1 || e.timeoutSeconds < 1) problems.push('the envelope has no retry budget or timeout');
  if (def && e.toolPermissions.some((t) => !def.tools.includes(t))) problems.push('the envelope grants a tool the registry did not bind to this agent');
  if (e.elevatedPermissions.some((t) => !e.toolPermissions.includes(t))) problems.push('an elevated permission is granted for a tool the agent does not hold');
  const secret = JSON.stringify(e).match(/(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)/);
  if (secret) problems.push('the envelope contains something that looks like a secret');
  return problems;
}

/** Every Phase 7 agent with the reason it cannot take work today: the record an Admin reads when a task is held. */
export function phaseSevenAgentStatus(enabled: ReadonlyMap<string, boolean>): { agent: string; enabled: boolean; tools: number; hasRoute: boolean }[] {
  return AGENT_DEFINITIONS.filter((d) => (AGENT_KEYS as readonly string[]).includes(d.key)).map((d) => ({ agent: d.key, enabled: enabled.get(d.key) === true, tools: d.tools.length, hasRoute: mayHandOff('orchestrator', d.key) }));
}
