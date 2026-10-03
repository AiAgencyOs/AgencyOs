import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  lockCovering,
  lockTaxPeriodSchema,
  unlockTaxPeriodSchema,
  type LockTaxPeriodInput,
  type UnlockTaxPeriodInput,
} from './tax-lock-schema';

type LockRow = { outcome: string; lock_id: string | null };

/**
 * GST reporting period locks — SCR-056.
 *
 * `invoice.issue` (owner, ops_admin) for both doors, the same pair
 * `tax_period_locks_write` admits: the people who may issue an invoice into
 * a period are the people who may close the period behind it. Both database
 * doors write their audit row in the same transaction; unlocking refuses
 * without a reason there as well as here.
 */
export async function lockTaxPeriod(input: LockTaxPeriodInput): Promise<Result<{ lockId: string; alreadyLocked: boolean }>> {
  const parsed = lockTaxPeriodSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid period.');

  const context = await requireInternal();
  if (!can(context, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to lock a reporting period.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('lock_tax_period', {
    p_period_start: parsed.data.periodStart,
    p_period_end: parsed.data.periodEnd,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
    ...(parsed.data.reportId ? { p_report_id: parsed.data.reportId } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'lockTaxPeriod', detail: error.message }));
    return err('INTERNAL', 'Could not lock the period.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as LockRow | undefined;
  if (!row) return err('INTERNAL', 'Could not lock the period.');

  switch (row.outcome) {
    case 'locked':
      if (!row.lock_id) return err('INTERNAL', 'Could not lock the period.');
      return ok({ lockId: row.lock_id, alreadyLocked: false });
    case 'already_locked':
      if (!row.lock_id) return err('INTERNAL', 'Could not lock the period.');
      return ok({ lockId: row.lock_id, alreadyLocked: true });
    case 'not_a_period':
      return err('VALIDATION', 'The period must end after it starts.');
    case 'report_mismatch':
      return err('VALIDATION', 'That report is not a snapshot of exactly this period, so the lock cannot refer to it.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'lockTaxPeriod', detail: `unrecognised outcome "${row.outcome}"` }));
      return err('INTERNAL', 'Could not lock the period.');
  }
}

export async function unlockTaxPeriod(input: UnlockTaxPeriodInput): Promise<Result<{ lockId: string; alreadyUnlocked: boolean }>> {
  const parsed = unlockTaxPeriodSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid unlock request.');

  const context = await requireInternal();
  if (!can(context, 'invoice.issue')) {
    return err('FORBIDDEN', 'You do not have permission to unlock a reporting period.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('unlock_tax_period', {
    p_lock_id: parsed.data.lockId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'unlockTaxPeriod', detail: error.message }));
    return err('INTERNAL', 'Could not unlock the period.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as LockRow | undefined;
  if (!row) return err('INTERNAL', 'Could not unlock the period.');

  switch (row.outcome) {
    case 'unlocked':
      return ok({ lockId: parsed.data.lockId, alreadyUnlocked: false });
    case 'already_unlocked':
      return ok({ lockId: parsed.data.lockId, alreadyUnlocked: true });
    case 'not_found':
      return err('NOT_FOUND', 'That lock is not visible to you.');
    case 'no_reason':
      return err('VALIDATION', 'Say why the period is being reopened.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'unlockTaxPeriod', detail: `unrecognised outcome "${row.outcome}"` }));
      return err('INTERNAL', 'Could not unlock the period.');
  }
}

export type ActiveTaxLock = { id: string; period_start: string; period_end: string; note: string | null };

/**
 * The active lock a calendar day falls inside, or null. Used by
 * `issueInvoice` and `voidInvoice` in service.ts; a read that fails is a
 * refusal, never "no lock", because an unreadable lock table must not let a
 * filed period be written into.
 */
export async function activeTaxLockCovering(
  supabase: Awaited<ReturnType<typeof createClient>>,
  isoDay: string,
): Promise<Result<ActiveTaxLock | null>> {
  const { data, error } = await supabase
    .schema('finance')
    .from('tax_period_locks')
    .select('id, period_start, period_end, note')
    .is('unlocked_at', null)
    .lte('period_start', isoDay)
    .gt('period_end', isoDay);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'activeTaxLockCovering', detail: error.message }));
    return err('INTERNAL', 'The reporting-period locks could not be read. Please try again.');
  }
  return ok(lockCovering(data ?? [], isoDay));
}
