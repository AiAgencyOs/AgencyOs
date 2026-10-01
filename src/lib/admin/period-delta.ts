/**
 * Period-over-period change for a KPI tile ("+12% vs last month").
 *
 * Nothing is stored for this: the figure is derived from timestamps the rows
 * already carry (created_at, paid_at, started_at). The "current" period is the
 * `days` ending at `now`; the "previous" period is the `days` before that.
 * Pure — no clock, no I/O — so the arithmetic is tested with real inputs.
 */

export type PeriodCounts = { current: number; previous: number };

export type PeriodDelta = { direction: 'up' | 'down'; percent: number | null; label: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function ms(at: string | Date | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Sums `amount` over the current and previous `days`-long windows. Rows outside both windows, or with no usable date, are ignored. */
export function sumPeriods(rows: { at: string | Date | null | undefined; amount?: number }[], now: Date, days = 30): PeriodCounts {
  const end = now.getTime();
  const mid = end - days * DAY_MS;
  const start = mid - days * DAY_MS;
  let current = 0;
  let previous = 0;
  for (const row of rows) {
    const t = ms(row.at);
    if (t === null || t > end) continue;
    const amount = row.amount ?? 1;
    if (t > mid) current += amount;
    else if (t > start) previous += amount;
  }
  return { current, previous };
}

/** How many of these dates fall in the current and previous `days`-long windows. */
export function countPeriods(dates: (string | Date | null | undefined)[], now: Date, days = 30): PeriodCounts {
  return sumPeriods(dates.map((at) => ({ at })), now, days);
}

/**
 * The chip for a pair of period totals, or null when there is nothing honest
 * to say: both periods empty, or no change. A rise from nothing reads "New"
 * (a percentage of zero is not a number).
 */
export function periodDelta({ current, previous }: PeriodCounts): PeriodDelta | null {
  if (current === previous) return null;
  if (previous <= 0) return current > 0 ? { direction: 'up', percent: null, label: 'New' } : null;
  const percent = Math.round(((current - previous) / previous) * 100);
  if (percent === 0) return null;
  return { direction: percent > 0 ? 'up' : 'down', percent, label: `${Math.abs(percent)}%` };
}

/** Shapes a delta for `<Stat trend>`; `goodWhenDown` flips the colour for a metric where less is better (overdue, failures, expenses). */
export function trendOf(delta: PeriodDelta | null, goodWhenDown = false): { direction: 'up' | 'down'; label: string; tone: 'success' | 'danger' } | undefined {
  if (!delta) return undefined;
  const good = goodWhenDown ? delta.direction === 'down' : delta.direction === 'up';
  return { direction: delta.direction, label: delta.label, tone: good ? 'success' : 'danger' };
}
