import { definitionFor, mayHandOff, type AgentCapability, type AgentDefinition } from '@/modules/agents/registry';

/**
 * The Orchestrator's routing decision — ORCH §4, §10.
 *
 * ORCH describes a capability registry, a `RoutingDecision` record, model and
 * provider candidates, cost/quality/latency policy and a retry/fallback
 * envelope. `docs/phase-4-gap-analysis.md` scopes this file down deliberately
 * to the one piece with a real precedent to reuse: `src/modules/agents/
 * registry.ts` already IS a capability registry (`AgentDefinition.capabilities`,
 * `handoffTargets`), and `mayHandOff` already IS the routing-permission check,
 * enforced a second time in the database by `ai.enforce_handoff_target`
 * (ADM-83). What did not exist anywhere in `src/` or `app/` was a caller that
 * turns "a task needs doing" into "here is the specific agent, and here is
 * why" — this function is that caller's decision half.
 *
 * **What this deliberately does not do.** No model or provider selection: the
 * agent runtime already resolves a model per `ai.agents.default_model`
 * (`20260807120008_ai.sql`), so choosing a MODEL is not a gap this file needs
 * to close. No cost/quality/latency ranking: today every task this router
 * handles has at most one capable candidate among a sender's declared
 * targets, so a ranking policy would be a knob nothing turns. Both are
 * explicitly out of scope for this slice — see the gap analysis's step 2 —
 * and the fallback below says so rather than pretending to rank silently.
 */

export type RouteOutcome =
  | {
      outcome: 'selected';
      fromAgent: string;
      toAgent: string;
      candidates: readonly string[];
      reason: string;
    }
  | {
      outcome: 'no_candidate';
      fromAgent: string;
      candidates: readonly string[];
      reason: string;
    }
  | {
      outcome: 'unknown_agent';
      fromAgent: string;
      reason: string;
    };

/**
 * Which of `fromAgent`'s declared handoff targets can do a task requiring
 * `requiredCapabilities`.
 *
 * Reads only `src/modules/agents/registry.ts` — the same file `ai.
 * agent_handoff_targets` mirrors and `check-record` §16 proves matches. A
 * candidate must both carry every required capability AND already be a
 * declared target of `fromAgent` (`mayHandOff`): capability alone is not
 * routing authority, or a task naming a capability would let it reach any
 * agent that happens to have one, bypassing ADM-83's boundary entirely.
 */
export function decideAgentForTask(input: {
  fromAgent: string;
  requiredCapabilities: readonly AgentCapability[];
}): RouteOutcome {
  const from = definitionFor(input.fromAgent);
  if (!from) {
    return {
      outcome: 'unknown_agent',
      fromAgent: input.fromAgent,
      reason: `${input.fromAgent} is not a registered agent`,
    };
  }

  const candidates = from.handoffTargets
    .filter((key) => mayHandOff(from.key, key))
    .map((key) => definitionFor(key))
    .filter((def): def is AgentDefinition => def !== null)
    .filter((def) => input.requiredCapabilities.every((cap) => def.capabilities.includes(cap)));

  if (candidates.length === 0) {
    return {
      outcome: 'no_candidate',
      fromAgent: from.key,
      candidates: [],
      reason:
        from.handoffTargets.length === 0
          ? `${from.key} has no declared handoff targets`
          : `none of ${from.handoffTargets.join(', ')} carries every required capability (${input.requiredCapabilities.join(', ')})`,
    };
  }

  // Simplification, stated rather than hidden (see module docblock): the
  // first capable candidate in declaration order wins. Revisit with an actual
  // ranking policy the day more than one candidate ever matches the same
  // task — today there is never more than one, so a ranking policy would be
  // unexercised code.
  const [selected] = candidates;
  if (!selected) {
    // Unreachable: the length check above already returned. Narrows the type
    // for the compiler rather than asserting past it.
    return { outcome: 'no_candidate', fromAgent: from.key, candidates: [], reason: 'unreachable' };
  }
  const candidateKeys = candidates.map((c) => c.key);
  return {
    outcome: 'selected',
    fromAgent: from.key,
    toAgent: selected.key,
    candidates: candidateKeys,
    reason:
      candidates.length === 1
        ? `${selected.key} is the only declared handoff target of ${from.key} carrying every required capability`
        : `${selected.key} chosen from ${candidateKeys.length} capable candidates (${candidateKeys.join(', ')}) by declaration order — no cost/quality/latency routing yet`,
  };
}

/**
 * Guard 1 — ORCH §10, §21: the Designer-activation guard.
 *
 * `decideAgentForTask` answers "who CAN do this by declared capability and
 * handoff edge" from the static registry alone. It cannot answer "is this
 * the moment the Designer may actually be woken" — that needs two live facts
 * the registry does not carry: whether the Phase 3 baseline this workspace
 * references is still locked, and whether `ui_designer` is enabled in
 * `ai.agents` today. Both can change after the registry was compiled, so
 * this is deliberately a second, later check rather than folded into
 * `decideAgentForTask` itself.
 *
 * Modeled on `projects.start_phase_four`'s own rule (20260923100000): an
 * event is a claim about the past, the row is the present, and a caller must
 * re-read the row rather than trust a payload or a workspace's own stale
 * state. `handleRouteTask2Design` re-reads both facts fresh before calling
 * this — see that module.
 *
 * This is application-side, defense-in-depth: `ai.enforce_handoff_target`
 * (extended in `20260928150000_a_disabled_agent_has_no_activation_reason.sql`)
 * refuses the same disabled-agent case a second time, independently, in the
 * database — the same two-layer arrangement `ai.enforce_handoff_target`
 * already keeps beside `mayHandOff` for the declared-target rule.
 */
export type ActivationCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkDesignerActivation(input: {
  readonly phaseThreeLocked: boolean;
  readonly designerEnabled: boolean;
}): ActivationCheck {
  if (!input.phaseThreeLocked) {
    return {
      ok: false,
      reason:
        'the Phase 3 baseline is not locked (phase_four_ready is not true on the referenced handoff) — ' +
        'there is no activation reason to route Task 2 design work to ui_designer',
    };
  }
  if (!input.designerEnabled) {
    return {
      ok: false,
      reason: 'ui_designer is disabled in ai.agents — there is no activation reason to route work to it',
    };
  }
  return { ok: true };
}

/**
 * Guard 2 — ORCH §22: the Finance-gate routing guard.
 *
 * "No AI route may claim final payment verification" cannot be checked
 * against a task payload — nothing here ever asks to route TO a payment
 * verdict, so there is nothing to intercept at call time. The genuine risk is
 * upstream of any single call: a future edit to `src/modules/agents/
 * registry.ts` that gives some agent a tool shaped like a payment-verifying
 * one, or a `handoffTargets` edge that would let an AI-driven chain reach it.
 * `finance.verify_payment_submission` (`src/modules/finance/service.ts`) is
 * SECURITY INVOKER, reached only through a real signed-in Admin session
 * (`app/(internal)/invoices/verify/page.tsx`) — there is no job-runner/service
 * form of the call for a tool to wrap in the first place.
 *
 * So the check is structural in the same sense `moneyAuthority`'s missing
 * `'decides'` member is structural (registry.ts's own docblock): it runs once,
 * over the whole roster, and fails loudly the moment the roster stops being
 * true, rather than waiting for a specific routing decision to exercise it.
 * `registry.ts` calls this at module load; `decideAgentForTask` never needs to
 * ask this question per-call because the roster can never carry a tool this
 * denylist would refuse.
 */
// Defined in registry.ts (not here) and re-exported, so the roster's own
// module-load self-check (registry.ts, beside `AGENT_KEYS`) can call it
// without route.ts importing registry.ts importing route.ts in a cycle.
// route.ts is still this guard's documented home — see the docblock above —
// because it is the ORCHESTRATOR's guard even though the roster is the thing
// it walks.
export { checkNoPaymentVerificationRoute } from '@/modules/agents/registry';
