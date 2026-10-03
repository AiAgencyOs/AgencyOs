import { z } from 'zod';

import type { CostRate } from './cost-rate-types';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date, like 2026-09-01');

/**
 * Setting a person's hourly cost rate — decision E2 of 2026-09-30. The
 * rate is a cost in paise per hour from a date; the form takes rupees and
 * `moneyToMinor` turns them into paise before the schema sees them.
 */
export const setMemberCostRateSchema = z.object({
  userId: z.uuid(),
  hourlyCostMinor: z.number().int().positive('The rate must be more than zero'),
  effectiveFrom: isoDate,
  note: z.string().trim().max(600).optional(),
});

export type SetMemberCostRateInput = z.infer<typeof setMemberCostRateSchema>;

/**
 * "850" or "850.50" (rupees) → 85050 (paise). Refuses anything else —
 * including a comma, a sign, or more than two decimals — with null, so a
 * typo never becomes a rate.
 */
export function moneyToMinor(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/**
 * The rate in force on a day: the latest `effectiveFrom <= day`, ties
 * (a correction from the same date) broken by the newer row. The same
 * rule as `projects.time_log_costs`' lateral join, written once in
 * TypeScript so the test can pin the arithmetic without a database.
 */
export function rateInForceOn<T extends Pick<CostRate, 'effectiveFrom' | 'createdAt'>>(
  rates: readonly T[],
  isoDay: string,
): T | null {
  let best: T | null = null;
  for (const r of rates) {
    if (r.effectiveFrom > isoDay) continue;
    if (
      best === null ||
      r.effectiveFrom > best.effectiveFrom ||
      (r.effectiveFrom === best.effectiveFrom && r.createdAt > best.createdAt)
    ) {
      best = r;
    }
  }
  return best;
}

/** `round(hours × rate)` in paise — the view's `cost_minor`, for a log with a rate. */
export function costOfLog(hours: number, hourlyCostMinor: number): number {
  return Math.round(hours * hourlyCostMinor);
}
