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
