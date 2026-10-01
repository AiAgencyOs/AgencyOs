import { z } from 'zod';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date, like 2026-09-01');

/**
 * Locking and unlocking a GST reporting period — SCR-056. The period is
 * half-open, `[periodStart, periodEnd)`, the same shape the tax page's
 * period resolver and finance.reconciliations use.
 */
export const lockTaxPeriodSchema = z
  .object({
    periodStart: isoDate,
    periodEnd: isoDate,
    note: z.string().trim().max(600).optional(),
    /** Q-D2: the dated report snapshot the filed return was made from. Optional; it must be of exactly this period. */
    reportId: z.uuid().optional(),
  })
  .refine((v) => v.periodEnd > v.periodStart, { message: 'The period must end after it starts.' });

export type LockTaxPeriodInput = z.infer<typeof lockTaxPeriodSchema>;

export const unlockTaxPeriodSchema = z.object({
  lockId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why the period is being reopened').max(600),
});

export type UnlockTaxPeriodInput = z.infer<typeof unlockTaxPeriodSchema>;

/** The lock a date falls inside, if any — pure, so the service and a test agree. */
export function lockCovering<T extends { period_start: string; period_end: string }>(
  locks: readonly T[],
  isoDay: string,
): T | null {
  return locks.find((l) => l.period_start <= isoDay && isoDay < l.period_end) ?? null;
}

/** The sentence a refused issue/void quotes, with the lock's note verbatim. */
export function lockedPeriodRefusal(lock: { period_start: string; period_end: string; note: string | null }, verb: string): string {
  const note = lock.note?.trim();
  return `This invoice cannot be ${verb}: its issue date falls inside the locked reporting period ${lock.period_start} to ${lock.period_end}${
    note ? ` — "${note}"` : ''
  }. Unlock the period on the GST & tax page first.`;
}
