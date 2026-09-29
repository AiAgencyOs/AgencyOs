/**
 * SCR-013 — the reactivation cohort, as the Follow-ups screen defines it.
 * Client-safe: no `server-only`, no database. The reader in
 * `reactivation-queries.ts` fetches the facts; the pure functions here
 * decide membership from them, so the rule is testable without a database
 * and cannot drift between the tile, the list and the test.
 *
 * A lead is in the cohort when ALL of these hold:
 *   1. its contact holds a granted WhatsApp consent row and the relationship
 *      admits re-engagement — `crm.reactivation_priority` admits exactly those
 *      and nothing here widens it;
 *   2. it has no OPEN follow-up sequence (active, escalated or stopped —
 *      the three states `crm.decide_follow_up_sequence` still decides on);
 *   3. nothing was recorded against it for at least `inactiveDays` — the
 *      ranking function's `last_active_at` (the newest of creation, lead
 *      activity and conversation message).
 *
 * No organisation setting names an inactivity threshold (the only
 * reactivation setting is `reactivation_max_per_run`, a per-tick cap), so the
 * panel's constant below is the N. Stated on the screen, never hidden.
 */

/** Days without a recorded activity before a consented lead counts as quiet. */
export const DEFAULT_REACTIVATION_INACTIVE_DAYS = 30;

/** The sequence states a person can still decide on — an open follow-up. */
export const OPEN_FOLLOW_UP_STATUSES = ['active', 'escalated', 'stopped'] as const;

/** One row from `crm.reactivation_priority`, as much of it as the cohort needs. */
export type ReactivationCandidate = {
  lead_id: string;
  tier_name: string;
  last_active_at: string;
  phone: string | null;
};

export type ReactivationCohortRow = {
  leadId: string;
  title: string;
  status: string;
  tierName: string;
  lastActiveAt: string;
  /** Whole days since `lastActiveAt`, at the time of the read. */
  quietDays: number;
  inPilot: boolean;
  assignedTo: string | null;
  phone: string | null;
  source: string;
  /** The Import batch that created this lead, when one did. */
  importBatchId: string | null;
  importSourceLabel: string | null;
};

export type ReactivationCohortFilter = 'all' | 'imported' | 'enrolled' | 'not_enrolled';
export const REACTIVATION_COHORT_FILTERS: readonly ReactivationCohortFilter[] = ['all', 'imported', 'enrolled', 'not_enrolled'];

export function isReactivationCohortFilter(v: string | undefined): v is ReactivationCohortFilter {
  return (REACTIVATION_COHORT_FILTERS as readonly string[]).includes(v ?? '');
}

/** The cutoff instant: anything active at or after it is not quiet. */
export function quietCutoff(now: Date, inactiveDays: number): Date {
  return new Date(now.getTime() - Math.max(0, inactiveDays) * 86_400_000);
}

/** Whole days between an instant and now, never negative. */
export function daysQuiet(lastActiveAt: string, now: Date): number {
  const ms = now.getTime() - Date.parse(lastActiveAt);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}

/**
 * Membership, from facts already read. `openFollowUpLeadIds` is the set of
 * lead ids with an open sequence; a candidate in it is out. A candidate whose
 * `last_active_at` is unparseable is out too — "quiet" is a claim about a
 * date, and a date that cannot be read supports no claim.
 */
export function selectReactivationCohort<T extends ReactivationCandidate>(
  candidates: readonly T[],
  openFollowUpLeadIds: ReadonlySet<string>,
  now: Date,
  inactiveDays: number = DEFAULT_REACTIVATION_INACTIVE_DAYS,
): T[] {
  const cutoff = quietCutoff(now, inactiveDays).getTime();
  return candidates.filter((c) => {
    if (openFollowUpLeadIds.has(c.lead_id)) return false;
    const at = Date.parse(c.last_active_at);
    return Number.isFinite(at) && at <= cutoff;
  });
}

/** The section's chips, each a predicate over rows. */
export function applyReactivationCohortFilter(rows: readonly ReactivationCohortRow[], filter: ReactivationCohortFilter): ReactivationCohortRow[] {
  switch (filter) {
    case 'imported':
      return rows.filter((r) => r.importBatchId !== null);
    case 'enrolled':
      return rows.filter((r) => r.inPilot);
    case 'not_enrolled':
      return rows.filter((r) => !r.inPilot);
    default:
      return [...rows];
  }
}
