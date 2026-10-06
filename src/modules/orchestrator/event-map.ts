import { definitionFor } from '@/modules/agents/registry';

import type { RouteCandidate } from './development-route';

/**
 * The Orchestrator's event map, QA half - Phase 5 Orchestrator spec section 11:
 *
 *   DevelopmentTaskQAFailed   Route defect/fix to original or Bug Fix specialist
 *   DevelopmentTaskQAPassed   Mark eligible for integration/acceptance
 *
 * Pure functions, one per event: given the facts (re-read from rows by the caller, never trusted from an event payload), each returns a routing
 * decision shaped for `projects.routing_decisions` (`routingDecisionRow`). No event type is added to `src/lib/events/catalog.ts` and nothing here is
 * subscribed: a decision function that no event reaches is the `built-and-unreachable` defect, so this file says so plainly. It becomes live the day
 * the QA verdict handler calls it; `recordRoutingDecision` in `orchestrator-service.ts` is the write that handler would make.
 *
 * What the Orchestrator never does here (ADM-82): judge completion, act as QA, override QA, certify delivery. `routeQaPassed` does not decide a task
 * is done: it decides whether a task QA already passed, independently and on the exact commit now present, is ELIGIBLE for integration. A QA pass that
 * is not independent, or is for another commit, is not eligible.
 */

export const QA_EVENTS = { failed: 'DevelopmentTaskQAFailed', passed: 'DevelopmentTaskQAPassed' } as const;

export type QaRoutingDecision = {
  outcome: 'routed' | 'held' | 'refused';
  /** `null` for "eligible for integration": there is no agent to hand it to yet, only a state the task may now enter. */
  toAgent: string | null;
  code: string;
  reason: string;
  candidates: RouteCandidate[];
  /** QA must re-verify the fix on the new build, and the fixer may not close its own defect. */
  requiresIndependentQa: boolean;
};

const BUG_FIX = 'bug_fix';

function candidate(agent: string, enabled: ReadonlyMap<string, boolean>, rejected: string | null): RouteCandidate {
  const known = definitionFor(agent) !== null;
  if (!known) return { agent, eligible: false, rejected: 'not a registered agent' };
  if (rejected) return { agent, eligible: false, rejected };
  if (enabled.get(agent) !== true) return { agent, eligible: false, rejected: 'agent is not enabled' };
  return { agent, eligible: true, rejected: null };
}

/**
 * QA failed a task: who fixes it?
 *
 * A DEFECT (the build does something wrong) goes to the Bug Fix specialist; INCOMPLETE work (the specialist did not finish) goes back to the
 * specialist that owns the task. Whichever is not available is the other's fallback. After the specialist's retry budget the task is refused, which
 * the caller escalates to a person: the loop never spins quietly.
 */
export function routeQaFailed(input: {
  originalSpecialist: string | null;
  failureKind: 'defect' | 'incomplete';
  /** 1 for the first failed QA. */
  attempt: number;
  /** `ai.agents.enabled` by key. */
  enabled: ReadonlyMap<string, boolean>;
}): QaRoutingDecision {
  const original = input.originalSpecialist && definitionFor(input.originalSpecialist) ? input.originalSpecialist : null;
  const budget = definitionFor(original ?? BUG_FIX)?.retry.maxAttempts ?? 3;
  const order = input.failureKind === 'defect' ? [BUG_FIX, original] : [original, BUG_FIX];
  const candidates = order.filter((a): a is string => a !== null).map((a) => candidate(a, input.enabled, null));

  if (input.attempt >= budget) {
    return {
      outcome: 'refused',
      toAgent: null,
      code: 'attempts_exhausted',
      reason: `QA has failed this task ${input.attempt} time(s) and the retry budget is ${budget}: a person decides next`,
      candidates,
      requiresIndependentQa: true,
    };
  }
  if (input.failureKind === 'incomplete' && original === null) {
    return {
      outcome: 'refused',
      toAgent: null,
      code: 'no_original_specialist',
      reason: 'QA found the work incomplete but the task has no registered specialist to finish it',
      candidates,
      requiresIndependentQa: true,
    };
  }

  const chosen = candidates.find((c) => c.eligible);
  if (!chosen) {
    const first = order.find((a): a is string => a !== null) ?? BUG_FIX;
    return {
      outcome: 'held',
      toAgent: first,
      code: 'agent_disabled',
      reason: `QA failed this task and neither ${candidates.map((c) => c.agent).join(' nor ')} is enabled to take it: held, not handed to an agent that cannot run`,
      candidates,
      requiresIndependentQa: true,
    };
  }

  const toBugFix = chosen.agent === BUG_FIX;
  const preferred = order.find((a): a is string => a !== null);
  const fellBack = chosen.agent !== preferred;
  return {
    outcome: 'routed',
    toAgent: chosen.agent,
    code: toBugFix ? 'qa_failed_to_bug_fix' : 'qa_failed_to_original_specialist',
    reason:
      `QA failed this task (${input.failureKind}): ${chosen.agent} fixes it${fellBack ? `, because ${preferred} is not available` : ''}. ` +
      'The fix returns to independent QA on the new build; the fixer does not close its own defect.',
    candidates,
    requiresIndependentQa: true,
  };
}

/**
 * QA passed a task: is it eligible for integration?
 *
 * Only a pass that is independent (the verifier is an agent allowed to verify, or a person, and not whoever produced the work), for the commit that
 * is now present, with any required security review finished and no open dependency.
 */
export function routeQaPassed(input: {
  producedBy: string;
  /** An agent key, or `user:<id>` for a person. */
  verifiedBy: string;
  qaCommit: string | null;
  currentCommit: string | null;
  securityReviewRequired: boolean;
  securityReviewDone: boolean;
  openDependencies: number;
}): QaRoutingDecision {
  const base = { candidates: [] as RouteCandidate[], requiresIndependentQa: false };

  const isPerson = input.verifiedBy.startsWith('user:');
  const verifier = isPerson ? null : definitionFor(input.verifiedBy);
  if (input.verifiedBy === input.producedBy || (!isPerson && !verifier?.mayVerify)) {
    return {
      ...base,
      outcome: 'refused',
      toAgent: null,
      code: 'qa_not_independent',
      reason: `${input.verifiedBy} may not pass work produced by ${input.producedBy}: a pass must come from an agent allowed to verify, or a person, and never from the producer`,
    };
  }
  if (input.qaCommit === null || input.currentCommit === null) {
    return { ...base, outcome: 'held', toAgent: null, code: 'qa_commit_unknown', reason: 'the QA pass does not name the commit it covered, so it cannot be tied to the build now present' };
  }
  if (input.qaCommit !== input.currentCommit) {
    return {
      ...base,
      outcome: 'held',
      toAgent: null,
      code: 'stale_qa_pass',
      reason: `QA passed ${input.qaCommit.slice(0, 12)} but the build is now ${input.currentCommit.slice(0, 12)}: a changed build is verified again, a prior pass is not reused`,
      requiresIndependentQa: true,
    };
  }
  if (input.securityReviewRequired && !input.securityReviewDone) {
    return { ...base, outcome: 'held', toAgent: 'security_review', code: 'security_review_pending', reason: 'QA passed, but this task is high-risk or security-sensitive and its security review is not finished' };
  }
  if (input.openDependencies > 0) {
    return { ...base, outcome: 'held', toAgent: null, code: 'dependencies_open', reason: `QA passed, but ${input.openDependencies} task(s) it depends on are not done` };
  }
  return {
    ...base,
    outcome: 'routed',
    toAgent: null,
    code: 'qa_passed_eligible_for_integration',
    reason: 'independent QA passed this exact commit; the task is eligible for integration and acceptance. Eligible is not accepted: acceptance is a separate decision.',
  };
}

/** The row `projects.routing_decisions` takes, same columns `handleDevelopmentPlan` writes. `(task_id, outcome, code)` is unique, so a replay writes nothing twice. */
export function routingDecisionRow(
  decision: QaRoutingDecision,
  ctx: { organizationId: string; projectId: string; planId: string | null; taskId: string; policyVersion: string; baselineRefs?: Record<string, unknown> },
) {
  return {
    organization_id: ctx.organizationId,
    project_id: ctx.projectId,
    plan_id: ctx.planId,
    task_id: ctx.taskId,
    to_agent: decision.toAgent,
    outcome: decision.outcome,
    code: decision.code,
    reason: decision.reason,
    candidates: decision.candidates,
    policy_version: ctx.policyVersion,
    baseline_refs: ctx.baselineRefs ?? {},
    correlation_id: ctx.planId,
  };
}
