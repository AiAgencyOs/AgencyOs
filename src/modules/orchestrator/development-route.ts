import { definitionFor, mayHandOff } from '@/modules/agents/registry';

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

export type DevelopmentRoute =
  | { outcome: 'routed'; toAgent: string; reason: string }
  | { outcome: 'held'; code: 'agent_disabled' | 'not_required'; toAgent: string; reason: string }
  | { outcome: 'refused'; code: 'no_capability' | 'not_a_specialist' | 'no_route'; reason: string };

export function decideDevelopmentRoute(input: {
  requiredCapability: string | null;
  /** `ai.agents.enabled` by key. */
  enabled: ReadonlyMap<string, boolean>;
  /** `projects.phase_five_agent_state.state` by agent key for this project. */
  agentState: ReadonlyMap<string, string>;
}): DevelopmentRoute {
  const key = input.requiredCapability?.trim();
  if (!key) return { outcome: 'refused', code: 'no_capability', reason: 'the task names no specialist; planning must assign one before it can be routed' };

  const def = definitionFor(key);
  // A model's output, or a hand-typed value, cannot route to an agent that is not a development specialist.
  if (!def || def.layer !== 'development') {
    return { outcome: 'refused', code: 'not_a_specialist', reason: `${key} is not a development specialist` };
  }
  if (!mayHandOff('orchestrator', key)) {
    return { outcome: 'refused', code: 'no_route', reason: `the Orchestrator has no declared route to ${key}` };
  }
  if (input.agentState.get(key) === 'not_required') {
    return { outcome: 'held', code: 'not_required', toAgent: key, reason: `${key} is recorded NOT_REQUIRED on this project` };
  }
  if (input.enabled.get(key) !== true) {
    return { outcome: 'held', code: 'agent_disabled', toAgent: key, reason: `${key} is installed but not enabled; the task waits rather than pretending to run` };
  }
  return { outcome: 'routed', toAgent: key, reason: `${key} carries the capability the approved plan assigned` };
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
    case 'permission_denied':
    case 'business_guard_failure':
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
};

export function buildExecutionEnvelope(input: {
  task: { id: string; title: string; acceptanceCriteria: string };
  planId: string;
  organizationId: string;
  projectId: string;
  baselineId: string | null;
  destination: string;
  routingReason: string;
  attempt?: number;
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
  };
}
