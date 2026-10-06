/**
 * Cost truthfulness and cost-aware ranking - Phase 5 Orchestrator spec sections 13 and 22:
 *
 *   "The cheapest route should never win if it fails required quality/capability/policy thresholds."
 *   A usage cost says where its number came from: reported, estimated or unknown.
 *
 * Pure. Two rules, each easy to break quietly:
 *
 *   1. Capability is a gate, cost is only a tiebreak ABOVE it. A route below the capability threshold is excluded before cost is looked at, so no
 *      price, however low, can put it first; and when nothing clears the threshold there is no winner (the caller escalates), not "the best of a bad
 *      lot".
 *   2. An unknown cost is not zero. It is never treated as the cheapest: among routes that clear the threshold, a known price outranks an unknown
 *      one, because "we do not know what this costs" is not "this is free".
 *
 * This file does not choose a provider or a model: `ai.routing_decisions` and `src/lib/ai/model-choice.ts` own that. It ranks whatever candidates it
 * is handed.
 */

export type CostSource = 'reported' | 'estimated' | 'unknown';

export type RouteCandidate = {
  key: string;
  /** How well the route fits the work, higher is better. The scale is the caller's; only the threshold and the order matter. */
  capability: number;
  /** USD. `null` when the source is `unknown`. */
  costUsd: number | null;
  costSource: CostSource;
};

export type RankedRoute = RouteCandidate & { rank: number };
export type ExcludedRoute = { key: string; reason: 'below_capability_threshold' | 'invalid_candidate' };

export type CostRanking = {
  /** Cheapest known first; unknown last; ties go to the more capable, then to the key so the order is deterministic. */
  ranked: RankedRoute[];
  excluded: ExcludedRoute[];
  /** The first ranked route, or null when none clears the threshold. */
  selected: RankedRoute | null;
  reason: string;
};

/** A cost record as the database holds it: `unknown` carries no number. Coerces anything inconsistent to `unknown`/null rather than to 0. */
export function normalizeCost(source: CostSource, costUsd: number | null | undefined): { costSource: CostSource; costUsd: number | null } {
  if (source === 'unknown') return { costSource: 'unknown', costUsd: null };
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return { costSource: 'unknown', costUsd: null };
  return { costSource: source, costUsd };
}

export function rankByCostWithinCapability(candidates: readonly RouteCandidate[], minCapability: number): CostRanking {
  const excluded: ExcludedRoute[] = [];
  const eligible: RouteCandidate[] = [];

  for (const candidate of candidates) {
    const cost = normalizeCost(candidate.costSource, candidate.costUsd);
    if (!Number.isFinite(candidate.capability)) {
      excluded.push({ key: candidate.key, reason: 'invalid_candidate' });
      continue;
    }
    if (candidate.capability < minCapability) {
      excluded.push({ key: candidate.key, reason: 'below_capability_threshold' });
      continue;
    }
    eligible.push({ ...candidate, ...cost });
  }

  const ranked = eligible
    .sort((a, b) => {
      if (a.costUsd !== null && b.costUsd === null) return -1;
      if (a.costUsd === null && b.costUsd !== null) return 1;
      if (a.costUsd !== null && b.costUsd !== null && a.costUsd !== b.costUsd) return a.costUsd - b.costUsd;
      if (a.capability !== b.capability) return b.capability - a.capability;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  const selected = ranked[0] ?? null;
  const reason = selected
    ? selected.costUsd === null
      ? `${selected.key} clears the capability threshold; no candidate that does has a known cost`
      : `${selected.key} is the cheapest of ${ranked.length} route(s) that clear the capability threshold (${minCapability})`
    : `no route clears the capability threshold (${minCapability}): ${excluded.length} excluded, none selected`;
  return { ranked, excluded, selected, reason };
}
