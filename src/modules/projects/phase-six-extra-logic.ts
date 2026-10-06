/** Pure rules for the Phase 6 dashboards: kept apart from the reads so they can be tested without a database. */

const DAY_MS = 86_400_000;

export type ExceptionState = 'expired' | 'expiring_soon' | 'current' | 'not_approved';

/** An exception that is not approved was never in force; an approved one is current until it expires, and is flagged in its last 7 days. */
export function exceptionState(status: string, expiresAt: string, now: number): ExceptionState {
  if (status !== 'approved') return 'not_approved';
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at) || at <= now) return 'expired';
  return at - now <= 7 * DAY_MS ? 'expiring_soon' : 'current';
}

/** Whole days between two instants, never negative. */
export function ageInDays(since: string, now: number): number {
  const at = Date.parse(since);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}
