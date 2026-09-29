import Link from 'next/link';

import { cx } from '../tokens';

/**
 * A month of days as a seven-column grid — the calendar mode SCR-010 asks
 * for, and SCR-022 will. Pure layout: it takes day keys (`YYYY-MM-DD`) and
 * whatever the page wants drawn in each cell, decides nothing about time
 * zones (the page's clock already did), and can render on the server.
 */
export type MonthGridDay = {
  /** `YYYY-MM-DD`, in whatever zone the page chose. */
  key: string;
  dayOfMonth: number;
  inMonth: boolean;
  isToday: boolean;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** The 5–6 weeks that show a month, Monday-first, padded with the neighbouring days. */
export function monthGridDays(year: number, month: number, todayKey: string): MonthGridDay[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(year, month - 1, 1 - lead));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  const days: MonthGridDay[] = [];
  for (let i = 0; i < total; i += 1) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, dayOfMonth: d.getUTCDate(), inMonth: d.getUTCMonth() === month - 1, isToday: key === todayKey });
  }
  return days;
}

export function MonthGrid({
  days,
  cells,
  title,
  prevHref,
  nextHref,
  className,
}: {
  days: readonly MonthGridDay[];
  /** What to draw in a day, keyed by its `YYYY-MM-DD`. */
  cells: ReadonlyMap<string, React.ReactNode>;
  title: React.ReactNode;
  prevHref: string;
  nextHref: string;
  className?: string;
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface shadow-xs', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <Link href={prevHref} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Previous month">
          ‹
        </Link>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <Link href={nextHref} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Next month">
          ›
        </Link>
      </div>
      <div className="grid grid-cols-7 border-b border-line text-[11px] font-semibold uppercase tracking-wide text-faint">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-2 py-1.5 text-center">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => (
          <div
            key={d.key}
            className={cx(
              'min-h-20 border-b border-r border-line p-1.5 text-[12px] sm:min-h-24',
              !d.inMonth && 'bg-surface-sunken text-faint',
            )}
          >
            <div className="flex items-center justify-between">
              <span
                className={cx(
                  'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 tabular',
                  d.isToday ? 'bg-brand text-brand-fg font-semibold' : 'text-muted',
                )}
              >
                {d.dayOfMonth}
              </span>
            </div>
            <div className="mt-1 flex flex-col gap-0.5">{cells.get(d.key) ?? null}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
