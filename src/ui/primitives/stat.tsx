import Link from 'next/link';

import { cx, TONE_CHIP, TONE_TEXT, type Tone } from '../tokens';
import { Badge } from './badge';

/**
 * A single number, with enough around it to be read correctly.
 *
 * The value is `tabular` so a column of figures lines up on the decimal, and
 * the caption is required-by-convention: a bare number on a dashboard is a
 * quiz, not a metric.
 *
 * `icon` renders in a pastel rounded-square chip (rather than bare) and
 * `trend` renders as a small delta badge beside the value — the KPI-tile
 * vocabulary in the AgencyOS Enterprise Admin Panel reference screenshots
 * (`admin panel ui single truth/`). Both are optional so a plain number-only
 * Stat stays exactly as before.
 */
export function Stat({
  label,
  value,
  caption,
  tone = 'neutral',
  icon,
  trend,
  href,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  caption?: React.ReactNode;
  tone?: Tone;
  icon?: React.ReactNode;
  /**
   * A trend delta, e.g. `{ direction: 'up', label: '+12%' }`. `tone` defaults
   * from `direction` (up → success, down → danger) but should be overridden
   * when "up" is the bad outcome for this particular metric — an increase in
   * overdue invoices is not good news just because the arrow points up.
   */
  trend?: { direction: 'up' | 'down'; label: React.ReactNode; tone?: 'success' | 'danger' };
  href?: string;
  className?: string;
}) {
  const trendTone = trend ? (trend.tone ?? (trend.direction === 'up' ? 'success' : 'danger')) : undefined;

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
        {icon ? (
          <span
            className={cx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
              TONE_CHIP[tone],
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p
          className={cx(
            'tabular text-2xl font-semibold leading-none tracking-tight sm:text-[28px]',
            tone === 'neutral' ? 'text-foreground' : TONE_TEXT[tone],
          )}
        >
          {value}
        </p>
        {trend && trendTone ? (
          <Badge tone={trendTone} className="gap-1">
            <span aria-hidden>{trend.direction === 'up' ? '↑' : '↓'}</span>
            {trend.label}
          </Badge>
        ) : null}
      </div>
      {caption ? <p className="mt-1.5 text-xs leading-relaxed text-muted">{caption}</p> : null}
    </>
  );

  const skin =
    'rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors sm:p-5';

  return href ? (
    <Link href={href} className={cx(skin, 'block hover:bg-surface-hover', className)}>
      {body}
    </Link>
  ) : (
    <div className={cx(skin, className)}>{body}</div>
  );
}

// Tailwind's JIT scanner needs the full class name written out somewhere in
// the source — `lg:grid-cols-${cols}` would never be generated. Every desktop
// column count `StatGrid` supports has to be a literal in this map.
const DESKTOP_COLS: Record<4 | 5 | 6, string> = {
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-3 xl:grid-cols-5',
  6: 'lg:grid-cols-3 xl:grid-cols-6',
};

/**
 * The row of metrics at the top of a screen.
 *
 * Two columns on a phone rather than one: these numbers are short, and a
 * single column pushes the actual content of the page below the fold.
 * Defaults to 4 desktop columns; pass `cols={5}`/`cols={6}` for a wider KPI
 * row (Dashboard's business snapshot and operational tiles, Integrations)
 * instead of hand-rolling a second grid.
 */
export function StatGrid({
  cols = 4,
  className,
  children,
}: {
  cols?: 4 | 5 | 6;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx('grid grid-cols-2 gap-3', DESKTOP_COLS[cols], className)}>{children}</div>
  );
}
