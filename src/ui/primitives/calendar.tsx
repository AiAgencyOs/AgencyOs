import Link from 'next/link';

import { cx, TONE_DOT, type Tone } from '../tokens';
import { IconChevronRight } from '../icons';

/**
 * A month grid — SCR-022's "Main calendar" mode, and the calendar-grid
 * primitive the codebase never had (`projects/[projectId]/calendar/page.tsx`
 * shipped list-only for exactly that reason). Pure and server-renderable: the
 * caller supplies the month and a day→entries map, and month navigation is an
 * ordinary `<Link>` to `?month=YYYY-MM` rather than client state, matching
 * `FilterBar`'s own GET-form convention elsewhere in this design system.
 */

export type CalendarEntry = {
  label: string;
  tone?: Tone;
  href?: string;
};

/** `YYYY-MM-DD` → local `Date` at midnight, without the UTC-parsing footgun of `new Date('YYYY-MM-DD')`. */
function parseDayKey(key: string): Date {
  const parts = key.split('-').map(Number);
  return new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
}

/** `YYYY-MM` → `[year, monthIndex1To12]`, both guaranteed numbers. */
function parseMonthKey(key: string): [number, number] {
  const parts = key.split('-').map(Number);
  return [parts[0] ?? 1970, parts[1] ?? 1];
}

function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function MonthGrid({
  month,
  entriesByDate,
  todayKey,
  monthHref,
  className,
  maxEntriesPerDay = 3,
}: {
  /** `YYYY-MM` — the month to render. */
  month: string;
  entriesByDate: Record<string, CalendarEntry[]>;
  /** `YYYY-MM-DD` for the day to highlight as "today". Omit on a page with no meaningful "today" (e.g. printing history). */
  todayKey?: string;
  /** Builds the href for a given `YYYY-MM` — used for the prev/next month links and the header. Omit to render a static grid with no navigation. */
  monthHref?: (month: string) => string;
  className?: string;
  /** How many entries a day cell shows before collapsing to "+N more". */
  maxEntriesPerDay?: number;
}) {
  const [year, monthIndex] = parseMonthKey(month);
  const firstOfMonth = new Date(year, monthIndex - 1, 1);
  const firstWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, monthIndex, 0).getDate();

  const prevMonth = new Date(year, monthIndex - 2, 1);
  const nextMonth = new Date(year, monthIndex, 1);
  const prevKey = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
  const nextKey = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;

  // Leading cells from the previous month, then every day of this month —
  // no trailing cells, so the grid is exactly as many rows as this month
  // needs (4-6) rather than always padded to a fixed 6x7.
  const cells: { dayKey: string; inMonth: boolean; dayNumber: number }[] = [];
  for (let i = 0; i < firstWeekday; i++) {
    const d = new Date(year, monthIndex - 1, -(firstWeekday - i - 1));
    cells.push({ dayKey: toDayKey(d), inMonth: false, dayNumber: d.getDate() });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, monthIndex - 1, day);
    cells.push({ dayKey: toDayKey(d), inMonth: true, dayNumber: day });
  }
  // Trailing cells so the grid always ends on a full week — a ragged last
  // row reads as a rendering bug, not a shorter month.
  while (cells.length % 7 !== 0) {
    const lastCell = cells[cells.length - 1];
    const last = parseDayKey(lastCell ? lastCell.dayKey : toDayKey(new Date(year, monthIndex - 1, daysInMonth)));
    const d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    cells.push({ dayKey: toDayKey(d), inMonth: false, dayNumber: d.getDate() });
  }

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      {monthHref ? (
        <div className="flex items-center justify-between gap-2">
          <Link
            href={monthHref(prevKey)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            aria-label="Previous month"
          >
            <IconChevronRight size={16} className="rotate-180" />
          </Link>
          <span className="text-sm font-semibold text-foreground">
            {firstOfMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          </span>
          <Link
            href={monthHref(nextKey)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            aria-label="Next month"
          >
            <IconChevronRight size={16} />
          </Link>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
        <div className="grid grid-cols-7 border-b border-line bg-surface-sunken">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-muted">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((cell, i) => {
            const dayEntries = entriesByDate[cell.dayKey] ?? [];
            const isToday = todayKey === cell.dayKey;
            const overflow = dayEntries.length - maxEntriesPerDay;
            return (
              <div
                key={cell.dayKey}
                className={cx(
                  'flex min-h-[88px] flex-col gap-1 border-b border-r border-line p-1.5 sm:min-h-[104px] sm:p-2',
                  i % 7 === 6 && 'border-r-0',
                  !cell.inMonth && 'bg-surface-sunken/50',
                )}
              >
                <span
                  className={cx(
                    'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium tabular',
                    isToday ? 'bg-brand text-brand-fg' : cell.inMonth ? 'text-foreground' : 'text-faint',
                  )}
                >
                  {cell.dayNumber}
                </span>
                <div className="flex flex-col gap-0.5">
                  {dayEntries.slice(0, maxEntriesPerDay).map((entry, j) =>
                    entry.href ? (
                      <Link
                        key={j}
                        href={entry.href}
                        className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] leading-tight text-foreground transition-colors hover:bg-surface-hover"
                      >
                        <span
                          aria-hidden
                          className={cx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[entry.tone ?? 'neutral'])}
                        />
                        <span className="truncate">{entry.label}</span>
                      </Link>
                    ) : (
                      <span key={j} className="flex items-center gap-1 truncate px-1 py-0.5 text-[11px] leading-tight text-foreground">
                        <span
                          aria-hidden
                          className={cx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[entry.tone ?? 'neutral'])}
                        />
                        <span className="truncate">{entry.label}</span>
                      </span>
                    ),
                  )}
                  {overflow > 0 ? <span className="px-1 text-[10px] text-faint">+{overflow} more</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
