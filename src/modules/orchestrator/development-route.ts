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
