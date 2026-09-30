/**
 * Calendar arithmetic over `YYYY-MM-DD` day keys — pure, zone-free.
 *
 * Due dates in this product are `date` columns, not instants, so a month
 * grid is built from the keys themselves with UTC arithmetic; no zone is
 * involved because no instant is. "Today" is the one thing that IS an
 * instant, and callers pass it in as the agency clock's `dayKey`.
 */

export type MonthGridDay = { key: string; inMonth: boolean; dayOfMonth: number };

export function monthKeyOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

export function isMonthKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function utc(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

function keyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Six-or-fewer weeks of seven days, Monday first, padded with the neighbouring months' days. */
export function monthGrid(monthKey: string): MonthGridDay[][] {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const first = utc(y, m - 1, 1);
  const daysInMonth = utc(y, m, 0).getUTCDate();
  // Monday = 0 … Sunday = 6.
  const lead = (first.getUTCDay() + 6) % 7;

  const cells: MonthGridDay[] = [];
  for (let i = -lead; cells.length < 42; i += 1) {
    const d = utc(y, m - 1, 1 + i);
    const inMonth = d.getUTCMonth() === m - 1;
    cells.push({ key: keyOf(d), inMonth, dayOfMonth: d.getUTCDate() });
    if (i >= daysInMonth - 1 && cells.length % 7 === 0) break;
  }

  const weeks: MonthGridDay[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const d = utc(y, m - 1 + delta, 1);
  return keyOf(d).slice(0, 7);
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(y, m - 1, 1));
}

/** The Monday-first week containing `dayKey`, as seven day keys. */
export function weekOf(dayKey: string): string[] {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const date = utc(y, m - 1, d);
  const lead = (date.getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => keyOf(utc(y, m - 1, d - lead + i)));
}

export function shiftDay(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  return keyOf(utc(y, m - 1, d + delta));
}

export function isDayKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
