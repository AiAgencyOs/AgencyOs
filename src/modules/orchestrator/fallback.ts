import { definitionFor, type AgentDefinition } from '@/modules/agents/registry';

/**
 * Fallback validation - Phase 5 Orchestrator spec section 20:
 *
 *   a fallback must satisfy the same specialist capability requirements; it cannot widen the agent's permissions; it must support the required
 *   tools; and if no safe eligible fallback exists, escalate.
 *
 * Pure, over the agent registry (`src/modules/agents/registry.ts`). "Fallback" here is an AGENT to hand a failed task to. The fallback MODEL and
 * PROVIDER is the existing AI routing layer's job (`ai.routing_decisions`, `src/lib/ai/model-choice.ts`) and is not duplicated here.
 *
 * The result is a verdict with every reason, not a boolean, because a rejected fallback is recorded (`projects.fallback_records`) and an Admin
 * reads why. Persisting is `recordFallback` in `orchestrator-service.ts`; the database keeps one rule of its own, that a fallback is accepted
 * exactly when no violation was found.
 */

export const FALLBACK_VIOLATION_CODES = [
  'unknown_primary',
  'unknown_fallback',
  'same_agent',
  'different_family',
  'capability_gap',
  'tool_widened',
  'money_authority_widened',
  'client_facing_widened',
  'verification_authority_widened',
  'handoff_widened',
  'verifier_changed',
] as const;
export type FallbackViolationCode = (typeof FALLBACK_VIOLATION_CODES)[number];

export type FallbackViolation = { code: FallbackViolationCode; detail: string };
export type FallbackVerdict = { valid: boolean; primary: string; fallback: string; violations: FallbackViolation[] };

const MONEY_RANK: Record<AgentDefinition['moneyAuthority'], number> = { none: 0, proposes_for_approval: 1 };

/**
 * The family a specialist belongs to: its registry layer. Development specialists fall back to development specialists, QA specialists to QA
 * specialists; a developer is never a fallback for QA (creator is not validator), and nothing falls back to the Orchestrator or onto a client-facing
 * agent from a back-office one.
 */
export function specialistFamily(def: AgentDefinition): string {
  return def.layer;
}

function resolve(agent: string | AgentDefinition): AgentDefinition | null {
  return typeof agent === 'string' ? definitionFor(agent) : agent;
}

/**
 * May `fallback` take over from `primary`? Valid only when it is the same family, can do the same work, and holds no more authority than the
 * primary did: no tool the primary lacked, no wider money, client or verification authority, no new handoff target, the same independent verifier.
 */
export function validateFallback(primaryAgent: string | AgentDefinition, fallbackAgent: string | AgentDefinition): FallbackVerdict {
  const primary = resolve(primaryAgent);
  const fallback = resolve(fallbackAgent);
  const names = {
    primary: typeof primaryAgent === 'string' ? primaryAgent : primaryAgent.key,
    fallback: typeof fallbackAgent === 'string' ? fallbackAgent : fallbackAgent.key,
  };
  const violations: FallbackViolation[] = [];

  if (!primary) violations.push({ code: 'unknown_primary', detail: `${names.primary} is not a registered agent` });
  if (!fallback) violations.push({ code: 'unknown_fallback', detail: `${names.fallback} is not a registered agent` });
  if (!primary || !fallback) return { valid: false, ...names, violations };

  if (primary.key === fallback.key) violations.push({ code: 'same_agent', detail: 'a fallback onto the same agent is a retry, not a fallback' });

  if (specialistFamily(primary) !== specialistFamily(fallback)) {
    violations.push({ code: 'different_family', detail: `${fallback.key} is a ${specialistFamily(fallback)} agent and ${primary.key} is a ${specialistFamily(primary)} agent` });
  }

  const missingCapabilities = primary.capabilities.filter((c) => !fallback.capabilities.includes(c));
  if (missingCapabilities.length > 0) {
    violations.push({ code: 'capability_gap', detail: `${fallback.key} lacks ${missingCapabilities.join(', ')}, which ${primary.key} carries` });
  }

  const wideTools = fallback.tools.filter((t) => !primary.tools.includes(t));
  if (wideTools.length > 0) {
    violations.push({ code: 'tool_widened', detail: `${fallback.key} holds ${wideTools.join(', ')}, which ${primary.key} does not: a fallback may hold fewer tools, never more` });
  }

  if (MONEY_RANK[fallback.moneyAuthority] > MONEY_RANK[primary.moneyAuthority]) {
    violations.push({ code: 'money_authority_widened', detail: `${fallback.key} has money authority ${fallback.moneyAuthority}, ${primary.key} has ${primary.moneyAuthority}` });
  }
  if (fallback.clientFacing && !primary.clientFacing) {
    violations.push({ code: 'client_facing_widened', detail: `${fallback.key} can reach a client and ${primary.key} cannot` });
  }
  if (fallback.mayVerify && !primary.mayVerify) {
    violations.push({ code: 'verification_authority_widened', detail: `${fallback.key} may decide that work is complete and ${primary.key} may not` });
  }

  const wideHandoffs = fallback.handoffTargets.filter((t) => !primary.handoffTargets.includes(t));
  if (wideHandoffs.length > 0) {
    violations.push({ code: 'handoff_widened', detail: `${fallback.key} may hand work to ${wideHandoffs.join(', ')}, which ${primary.key} may not` });
  }

  if (fallback.verification.verifiedBy !== primary.verification.verifiedBy) {
    violations.push({ code: 'verifier_changed', detail: `${fallback.key} is verified by ${fallback.verification.verifiedBy ?? 'nobody'}, ${primary.key} by ${primary.verification.verifiedBy ?? 'nobody'}` });
  }

  return { valid: violations.length === 0, ...names, violations };
}

/**
 * Every agent that could take over from `primary`, in registry order, with the verdict for each rejected one. Empty `eligible` is the escalate case
 * (Orchestrator spec section 20: "escalate if no safe eligible fallback exists").
 */
export function eligibleFallbacks(primaryKey: string, candidates: readonly AgentDefinition[]): { eligible: string[]; rejected: FallbackVerdict[] } {
  const eligible: string[] = [];
  const rejected: FallbackVerdict[] = [];
  for (const candidate of candidates) {
    if (candidate.key === primaryKey) continue;
    const verdict = validateFallback(primaryKey, candidate);
    if (verdict.valid) eligible.push(candidate.key);
    else rejected.push(verdict);
  }
  return { eligible, rejected };
}
