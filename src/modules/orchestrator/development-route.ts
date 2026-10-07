import { AGENT_DEFINITIONS, definitionFor, mayHandOff, registryRevision } from '@/modules/agents/registry';

/**
 * Phase 5 development routing - Phase 5 Orchestrator spec: capability matching, eligibility, creator != validator.
 *
 * The Orchestrator ROUTES; it never approves, verifies, changes scope or grants a tool. A task names the specialist it needs
 * (`required_capability`, fixed at planning time and approved by an Admin); this decides whether that specialist can take it NOW, and says why
 * not. Pure: the facts (is the agent enabled, is it recorded NOT_REQUIRED on this project) are passed in, so the same rule serves the handler and
 * the tests.
 *
 * "Held" is an honest outcome, not a failure: every specialist is installed disabled, so today every routable task is HELD with the reason
 * stated, rather than a handoff to an agent that cannot run being recorded as if work had started.
 */

export type RouteCandidate = { agent: string; eligible: boolean; rejected: string | null };

export type DevelopmentRoute =
  | { outcome: 'routed'; toAgent: string; reason: string; candidates: RouteCandidate[]; requiresSecurityReview: boolean }
  | {
      outcome: 'held';
      code: 'agent_disabled' | 'not_required' | 'no_baseline' | 'dependencies_open';
      toAgent: string;
      reason: string;
      candidates: RouteCandidate[];
      requiresSecurityReview: boolean;
    }
  | {
      outcome: 'refused';
      code: 'no_capability' | 'not_a_specialist' | 'no_route' | 'activation_condition' | 'production_deploy_not_permitted';
      reason: string;
      candidates: RouteCandidate[];
      requiresSecurityReview: boolean;
    };

/** Paths and risk levels that call for the security specialist's review of the build (Phase 5 Orchestrator spec, specialist selection). */
const SECURITY_SENSITIVE_PATH = /(^|\/)(auth|middleware|rls|policies|permissions|security|payments?|billing|secrets?)(\/|\.|$)|supabase\/migrations\//i;
const PRODUCTION_DEPLOY = /\b(deploy|release|publish|push)\b[^.\n]{0,40}\b(to\s+)?(prod|production|live|app\s*store|play\s*store)\b/i;

export function requiresSecurityReview(riskLevel: string | null | undefined, affectedPaths: readonly string[] | null | undefined): boolean {
  if (riskLevel === 'high' || riskLevel === 'critical') return true;
  return (affectedPaths ?? []).some((p) => SECURITY_SENSITIVE_PATH.test(p));
}

export function decideDevelopmentRoute(input: {
  requiredCapability: string | null;
  /** `ai.agents.enabled` by key. */
  enabled: ReadonlyMap<string, boolean>;
  /** `projects.phase_five_agent_state.state` by agent key for this project. */
  agentState: ReadonlyMap<string, string>;
  /** The locked baseline's id. `undefined` = the caller did not look; `null` = there is none (a task is never routed against "the latest design"). */
  baselineId?: string | null;
  /** Upstream tasks that are not yet done. */
  openDependencies?: number;
  riskLevel?: string | null;
  affectedPaths?: readonly string[] | null;
  taskText?: string;
  /** Is a QA defect linked to this task (a Bug Fix task needs one)? */
  hasLinkedDefect?: boolean;
}): DevelopmentRoute {
  const secure = requiresSecurityReview(input.riskLevel, input.affectedPaths);
  const key = input.requiredCapability?.trim();
  // every development specialist is a candidate; each says why it was not chosen (the record an Admin reads when a route surprises them)
  const candidates: RouteCandidate[] = AGENT_DEFINITIONS.filter((d) => d.layer === 'development').map((d) => {
    if (d.key !== key) return { agent: d.key, eligible: false, rejected: 'the plan assigned a different specialist' };
    if (!mayHandOff('orchestrator', d.key)) return { agent: d.key, eligible: false, rejected: 'no declared route from the Orchestrator' };
    if (input.agentState.get(d.key) === 'not_required') return { agent: d.key, eligible: false, rejected: 'recorded NOT_REQUIRED on this project' };
    if (input.enabled.get(d.key) !== true) return { agent: d.key, eligible: false, rejected: 'installed but not enabled' };
    return { agent: d.key, eligible: true, rejected: null };
  });
  const base = { candidates, requiresSecurityReview: secure };

  if (!key) return { outcome: 'refused', code: 'no_capability', reason: 'the task names no specialist; planning must assign one before it can be routed', ...base };

  const def = definitionFor(key);
  // A model's output, or a hand-typed value, cannot route to an agent that is not a development specialist.
  if (!def || def.layer !== 'development') {
    return { outcome: 'refused', code: 'not_a_specialist', reason: `${key} is not a development specialist`, ...base };
  }
  if (!mayHandOff('orchestrator', key)) {
    return { outcome: 'refused', code: 'no_route', reason: `the Orchestrator has no declared route to ${key}`, ...base };
  }
  // activation conditions: a specialist is chosen only for the work it exists for
  if (key === 'bug_fix' && input.hasLinkedDefect === false) {
    return { outcome: 'refused', code: 'activation_condition', reason: 'a Bug Fix task needs a verified defect to fix; a new feature mislabelled as a bug goes back to planning', ...base };
  }
  if (input.taskText && PRODUCTION_DEPLOY.test(input.taskText)) {
    return { outcome: 'refused', code: 'production_deploy_not_permitted', reason: 'Phase 5 builds and tests; deploying to production is Phase 7 and is never routed to a development specialist', ...base };
  }
  if (input.agentState.get(key) === 'not_required') {
    return { outcome: 'held', code: 'not_required', toAgent: key, reason: `${key} is recorded NOT_REQUIRED on this project`, ...base };
  }
  if (input.baselineId === null) {
    return { outcome: 'held', code: 'no_baseline', toAgent: key, reason: 'there is no locked development baseline: work is never routed against "the latest design"', ...base };
  }
  if ((input.openDependencies ?? 0) > 0) {
    return { outcome: 'held', code: 'dependencies_open', toAgent: key, reason: `${input.openDependencies} upstream task(s) are not done; the task waits for what it depends on`, ...base };
  }
  if (input.enabled.get(key) !== true) {
    return { outcome: 'held', code: 'agent_disabled', toAgent: key, reason: `${key} is installed but not enabled; the task waits rather than pretending to run`, ...base };
  }
  return { outcome: 'routed', toAgent: key, reason: `${key} carries the capability the approved plan assigned`, ...base };
}

/** The policy the decision was made under: the registry revision. A decision made under an older revision is explainable by it. */
export function routingPolicyVersion(): string {
  return `registry-${registryRevision()}`;
}

/**
 * Who independently reviews a producer's work. Creator != validator, and QA - not the Orchestrator and not the producer - owns completion.
 * A specialist is verified by `quality_assurance`; its code is reviewed by `security_review`, which never reviews its own output
 * (that review needs a person).
 */
export function decideIndependentReviewer(producerKey: string): { reviewer: string | null; verifier: string | null; reason: string } {
  const def = definitionFor(producerKey);
  if (!def) return { reviewer: null, verifier: null, reason: `${producerKey} is not a registered agent` };
  const verifier = def.verification.verifiedBy && def.verification.verifiedBy !== producerKey ? def.verification.verifiedBy : null;
  const reviewer = producerKey === 'security_review' ? null : 'security_review';
  return {
    reviewer,
    verifier,
    reason: reviewer ? 'reviewed by security_review, verified by quality_assurance' : 'security_review cannot review its own work: a person reviews it',
  };
}

/**
 * Failure classes and what may be done about each - Phase 5 Orchestrator spec, "RETRY / FALLBACK".
 *
 * A retry is safe only when repeating the work cannot repeat a side effect. An uncertain side effect (a message that may or may not have gone
 * out, a build that may or may not have been stored) is RECONCILED first, never blindly retried. A guard or permission refusal is never retried
 * and never "fallen back" around: a fallback model must not widen a permission.
 */
export const FAILURE_CLASSES = [
  'transient_provider_error',
  'timeout',
  'rate_limit',
  'tool_failure',
  'schema_failure',
  'invalid_output',
  'permission_denied',
  'no_capable_route',
  'side_effect_uncertain',
  'business_guard_failure',
  'build_failure',
  'test_failure',
  'dependency_blocked',
  'repo_conflict',
  'policy_block',
  'tool_unavailable',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type FailureHandling = {
  retry: 'safe' | 'after_reconcile' | 'never';
  /** A different model/provider may be tried (it never carries more permission than the original). */
  fallback: boolean;
  escalate: boolean;
};

export function handleExecutionFailure(failure: FailureClass, attempt: number, maxAttempts: number): FailureHandling {
  const exhausted = attempt >= maxAttempts;
  switch (failure) {
    case 'transient_provider_error':
    case 'timeout':
    case 'rate_limit':
      return { retry: exhausted ? 'never' : 'safe', fallback: true, escalate: exhausted };
    case 'tool_failure':
    case 'schema_failure':
    case 'invalid_output':
      // the same input will usually give the same answer: one more attempt through a different route, then a person
      return { retry: exhausted ? 'never' : 'safe', fallback: !exhausted, escalate: exhausted };
    case 'side_effect_uncertain':
      return { retry: 'after_reconcile', fallback: false, escalate: true };
    case 'build_failure':
    case 'test_failure':
      // a deterministic failure goes back to the SAME specialist to fix; it is never retried blindly and never marks the task complete
      return { retry: exhausted ? 'never' : 'safe', fallback: false, escalate: exhausted };
    case 'tool_unavailable':
      return { retry: exhausted ? 'never' : 'safe', fallback: !exhausted, escalate: exhausted };
    case 'dependency_blocked':
    case 'repo_conflict':
      // wait or serialize: repeating the run now would collide again
      return { retry: 'never', fallback: false, escalate: false };
    case 'permission_denied':
    case 'business_guard_failure':
    case 'policy_block':
    case 'no_capable_route':
      return { retry: 'never', fallback: false, escalate: true };
  }
}

/**
 * The execution envelope a specialist run is given (spec: every important run carries these). It is a record of what was ASKED and ALLOWED;
 * it grants nothing the registry did not already declare, and the model never edits it.
 */
export type ExecutionEnvelope = {
  taskId: string;
  planId: string;
  correlationId: string;
  organizationId: string;
  projectId: string;
  baselineId: string | null;
  sourceActor: 'orchestrator';
  destination: string;
  intent: string;
  acceptanceCriteria: string;
  toolPermissions: readonly string[];
  dataClassification: 'internal';
  timeoutSeconds: number;
  retryBudget: number;
  idempotencyKey: string;
  routingReason: string;
  attempt: number;
  /** The registry revision the specialist definition came from. */
  specialistRevision: string;
  riskClass: 'low' | 'medium' | 'high' | 'critical' | null;
  affectedPaths: readonly string[];
  dependencyTaskIds: readonly string[];
  /** What the specialist may NEVER do, whatever its prompt says. */
  forbiddenActions: readonly string[];
  /** The evidence a result must carry before QA will look at it (from the registry's verification contract). */
  requiredEvidence: readonly string[];
  baselineRefs: { scopeVersionId: string | null; uiVersionId: string | null; prototypeVersionId: string | null };
  repository: { repositoryId: string | null; baseCommit: string | null };
  requiresSecurityReview: boolean;
};

/** The same list for every specialist: Phase 5 builds and tests. It approves, merges, deploys and pays nothing. */
export const FORBIDDEN_ACTIONS: readonly string[] = [
  'deploy to production',
  'publish to an app store',
  'merge to a protected branch',
  'approve or verify its own work',
  'change scope or the locked baseline',
  'verify a payment or issue a refund',
  'write a secret value into a log, commit or message',
];

export function buildExecutionEnvelope(input: {
  task: { id: string; title: string; acceptanceCriteria: string };
  planId: string;
  organizationId: string;
  projectId: string;
  baselineId: string | null;
  destination: string;
  routingReason: string;
  attempt?: number;
  riskLevel?: string | null;
  affectedPaths?: readonly string[] | null;
  dependencyTaskIds?: readonly string[];
  baselineRefs?: { scopeVersionId: string | null; uiVersionId: string | null; prototypeVersionId: string | null };
  repository?: { repositoryId: string | null; baseCommit: string | null };
}): ExecutionEnvelope {
  const def = definitionFor(input.destination);
  return {
    taskId: input.task.id,
    planId: input.planId,
    correlationId: input.planId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    baselineId: input.baselineId,
    sourceActor: 'orchestrator',
    destination: input.destination,
    intent: `Development task: ${input.task.title}`,
    acceptanceCriteria: input.task.acceptanceCriteria,
    // the specialist's tools are what the REGISTRY binds to it: a model asking for more is asking for something that does not exist
    toolPermissions: def ? [...def.tools] : [],
    dataClassification: 'internal',
    timeoutSeconds: 900,
    retryBudget: def?.retry.maxAttempts ?? 1,
    idempotencyKey: `${input.task.id}:${input.planId}:${input.attempt ?? 1}`,
    routingReason: input.routingReason,
    attempt: input.attempt ?? 1,
    specialistRevision: registryRevision(),
    riskClass: (['low', 'medium', 'high', 'critical'] as const).find((r) => r === input.riskLevel) ?? null,
    affectedPaths: [...(input.affectedPaths ?? [])],
    dependencyTaskIds: [...(input.dependencyTaskIds ?? [])],
    forbiddenActions: FORBIDDEN_ACTIONS,
    requiredEvidence: def ? [...def.verification.requiredEvidence] : [],
    baselineRefs: input.baselineRefs ?? { scopeVersionId: null, uiVersionId: null, prototypeVersionId: null },
    repository: input.repository ?? { repositoryId: null, baseCommit: null },
    requiresSecurityReview: requiresSecurityReview(input.riskLevel, input.affectedPaths),
  };
}

/**
 * An envelope that is incomplete or unsafe is REJECTED, not repaired (Orchestrator spec: "reject or reconcile"). The specialist is only ever
 * handed an envelope that names its task, plan, tenant, baseline, acceptance criteria, evidence and limits, and that carries no secret.
 */
export function validateExecutionEnvelope(e: ExecutionEnvelope): string[] {
  const problems: string[] = [];
  if (!e.taskId || !e.planId || !e.organizationId || !e.projectId) problems.push('the envelope does not name its task, plan, organization and project');
  if (!e.baselineId) problems.push('the envelope has no locked baseline');
  if (!e.acceptanceCriteria || e.acceptanceCriteria.trim().length === 0) problems.push('the task has no acceptance criteria');
  if (!definitionFor(e.destination) || definitionFor(e.destination)?.layer !== 'development') problems.push('the destination is not a development specialist');
  if (e.requiredEvidence.length === 0) problems.push('the envelope names no required evidence');
  if (e.forbiddenActions.length === 0) problems.push('the envelope carries no forbidden-action list');
  if (e.retryBudget < 1 || e.timeoutSeconds < 1) problems.push('the envelope has no retry budget or timeout');
  const secret = JSON.stringify(e).match(/(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)/);
  if (secret) problems.push('the envelope contains something that looks like a secret');
  const def = definitionFor(e.destination);
  if (def && e.toolPermissions.some((t) => !def.tools.includes(t))) problems.push('the envelope grants a tool the registry did not bind to this specialist');
  return problems;
}
