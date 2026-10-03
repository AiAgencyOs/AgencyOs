import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads over finance.tax_period_locks — SCR-056. Refuses on failure
 * (G-054): a lock table that could not be read must not render as "this
 * period is open".
 */

export type TaxPeriodLockRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  lockedBy: string | null;
  lockedByName: string | null;
  lockedAt: string;
  note: string | null;
  unlockedAt: string | null;
  unlockedBy: string | null;
  unlockedByName: string | null;
  unlockReason: string | null;
  /** Q-D2: the dated report snapshot the lock refers to, if one was named. */
  periodReportId: string | null;
};

/** Every lock, active and released, newest first. */
export async function listTaxPeriodLocks(limit = 200): Promise<TaxPeriodLockRow[]> {
  const supabase = await createClient();

  const { data, error: locksError } = await supabase
    .schema('finance')
    .from('tax_period_locks')
    .select('id, period_start, period_end, locked_by, locked_at, note, unlocked_at, unlocked_by, unlock_reason, period_report_id')
    .order('locked_at', { ascending: false })
    .limit(limit);

  if (locksError) unreadable('listTaxPeriodLocks', locksError);

  const rows = data ?? [];
  const userIds = [...new Set(rows.flatMap((r) => [r.locked_by, r.unlocked_by]).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .schema('core')
      .from('users')
      .select('id, full_name, email')
      .in('id', userIds);
    if (usersError) unreadable('listTaxPeriodLocks.users', usersError);
    for (const u of users ?? []) nameById.set(u.id, u.full_name ?? u.email ?? u.id);
  }

  return rows.map((r) => ({
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    lockedBy: r.locked_by,
    lockedByName: r.locked_by ? (nameById.get(r.locked_by) ?? null) : null,
    lockedAt: r.locked_at,
    note: r.note,
    unlockedAt: r.unlocked_at,
    unlockedBy: r.unlocked_by,
    unlockedByName: r.unlocked_by ? (nameById.get(r.unlocked_by) ?? null) : null,
    unlockReason: r.unlock_reason,
    periodReportId: r.period_report_id,
  }));
}

/**
 * The lock state of one exact period: the active lock on it, and any active
 * lock that overlaps it (a locked financial year covers every month inside
 * it, so a month page must say so even when the month itself was never
 * locked by name).
 */
export function lockStateFor(
  locks: readonly TaxPeriodLockRow[],
  periodStart: string,
  periodEnd: string,
): { exact: TaxPeriodLockRow | null; overlapping: TaxPeriodLockRow[] } {
  const active = locks.filter((l) => l.unlockedAt === null);
  const exact = active.find((l) => l.periodStart === periodStart && l.periodEnd === periodEnd) ?? null;
  const overlapping = active.filter((l) => l !== exact && l.periodStart < periodEnd && periodStart < l.periodEnd);
  return { exact, overlapping };
}
