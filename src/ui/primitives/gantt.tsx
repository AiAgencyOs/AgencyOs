import { cx, type Tone } from '../tokens';

export type GanttRow = {
  id: string;
  label: string;
  caption?: string;
  /** `YYYY-MM-DD` — the window's first day. */
  start: string;
  /** `YYYY-MM-DD` — the window's last day. */
  end: string;
  state: 'done' | 'current' | 'upcoming' | 'late';
  /** 0–100, printed on the bar when given. */
  progress?: number;
  href?: string;
};

const BAR: Record<GanttRow['state'], string> = {
  done: 'bg-success',
  current: 'bg-brand',
  upcoming: 'bg-surface-sunken ring-1 ring-inset ring-line-strong',
  late: 'bg-danger',
};

const DOT: Record<GanttRow['state'], Tone> = { done: 'success', current: 'brand', upcoming: 'neutral', late: 'danger' };
const DOT_CLASS: Record<Tone, string> = { neutral: 'bg-faint', brand: 'bg-brand', accent: 'bg-accent', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-info' };

function dayIndex(key: string): number {
  return Math.floor(Date.parse(`${key}T00:00:00Z`) / 86_400_000);
}

function monthLabel(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * A milestone timeline drawn as bars — the reference's "Project Milestone
 * Timeline (Gantt)". Every bar is a window the caller derived from stored
 * dates; the component only scales them onto one axis, marks the months and
 * draws today's line. It stores nothing and invents no duration.
 */
export function Gantt({ rows, todayKey, className }: { rows: readonly GanttRow[]; todayKey?: string; className?: string }) {
  if (rows.length === 0) return null;
  const starts = rows.map((r) => dayIndex(r.start));
  const ends = rows.map((r) => dayIndex(r.end));
  const min = Math.min(...starts, todayKey ? dayIndex(todayKey) : Infinity) - 2;
  const max = Math.max(...ends, todayKey ? dayIndex(todayKey) : -Infinity) + 2;
  const span = Math.max(1, max - min);
  const pct = (day: number) => ((day - min) / span) * 100;

  // One tick per month boundary inside the range.
  const ticks: { key: string; left: number }[] = [];
  const first = new Date(min * 86_400_000);
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  while (Math.floor(cursor.getTime() / 86_400_000) < max) {
    const key = cursor.toISOString().slice(0, 10);
    ticks.push({ key, left: pct(dayIndex(key)) });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const todayLeft = todayKey ? pct(dayIndex(todayKey)) : null;

  return (
    <div className={cx('overflow-x-auto', className)}>
      <div className="min-w-[36rem]">
        <div className="grid grid-cols-[minmax(11rem,16rem)_1fr] border-b border-line text-[11px] font-semibold uppercase tracking-wider text-muted">
          <div className="px-3 py-2">Milestone</div>
          <div className="relative h-8">
            {/* The range's own month, unless the first boundary is so close the two labels would collide. */}
            {(ticks[0]?.left ?? 100) > 22 ? (
              <span className="absolute left-1 top-2">{monthLabel(new Date(min * 86_400_000).toISOString().slice(0, 10))}</span>
            ) : null}
            {ticks.map((t) => (
              <span key={t.key} className="absolute top-2 -translate-x-1/2 whitespace-nowrap" style={{ left: `${t.left}%` }}>
                {monthLabel(t.key)}
              </span>
            ))}
          </div>
        </div>
        <ol className="relative">
          {rows.map((r) => {
            const left = pct(dayIndex(r.start));
            const width = Math.max(1.5, pct(dayIndex(r.end) + 1) - left);
            const bar = (
              <span
                className={cx('absolute top-1/2 flex h-5 -translate-y-1/2 items-center rounded-md px-2 text-[11px] font-semibold', BAR[r.state], r.state === 'upcoming' ? 'text-muted' : 'text-white')}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${r.label}: ${r.start} → ${r.end}`}
              >
                {typeof r.progress === 'number' && width > 8 ? `${r.progress}%` : null}
              </span>
            );
            return (
              <li key={r.id} className="grid grid-cols-[minmax(11rem,16rem)_1fr] border-b border-line last:border-0">
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span aria-hidden className={cx('h-2.5 w-2.5 shrink-0 rounded-full', DOT_CLASS[DOT[r.state]])} />
                  <span className="min-w-0">
                    {r.href ? (
                      <a href={r.href} className="block truncate text-[13px] font-medium text-foreground hover:text-brand">
                        {r.label}
                      </a>
                    ) : (
                      <span className="block truncate text-[13px] font-medium text-foreground">{r.label}</span>
                    )}
                    {r.caption ? <span className="block truncate text-[11px] text-muted">{r.caption}</span> : null}
                  </span>
                </div>
                <div className="relative h-11">
                  {ticks.map((t) => (
                    <span key={t.key} aria-hidden className="absolute inset-y-0 border-l border-dashed border-line" style={{ left: `${t.left}%` }} />
                  ))}
                  {todayLeft !== null ? <span aria-hidden className="absolute inset-y-0 border-l-2 border-dashed border-sidebar-bg/60" style={{ left: `${todayLeft}%` }} /> : null}
                  {bar}
                </div>
              </li>
            );
          })}
        </ol>
        {todayKey ? (
          <div className="grid grid-cols-[minmax(11rem,16rem)_1fr]">
            <div />
            <div className="relative h-5">
              {todayLeft !== null ? (
                <span className="absolute -translate-x-1/2 rounded-full bg-sidebar-bg px-2 py-0.5 text-[10px] font-semibold text-sidebar-fg" style={{ left: `${todayLeft}%` }}>
                  Today
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-4 px-3 py-2 text-[11px] text-muted">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success" /> Completed</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand" /> In progress</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-danger" /> Late</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-faint" /> Upcoming</span>
        </div>
      </div>
    </div>
  );
}
