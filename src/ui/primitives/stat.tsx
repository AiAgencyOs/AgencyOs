import Link from 'next/link';

import { cx, TONE_CHIP, type Tone } from '../tokens';
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
  compact = false,
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
  /** Narrower chip and padding for a six-across KPI row (the project overview). */
  compact?: boolean;
}) {
  const trendTone = trend ? (trend.tone ?? (trend.direction === 'up' ? 'success' : 'danger')) : undefined;

  const figure = (
    <>
      <p className="text-[13px] font-medium leading-tight text-muted">{label}</p>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="tabular max-w-full break-words text-[22px] font-bold leading-none tracking-tight text-foreground sm:text-2xl">{value}</p>
        {trend && trendTone ? (
          <Badge tone={trendTone} className="gap-1">
            <span aria-hidden>{trend.direction === 'up' ? '↑' : '↓'}</span>
            {trend.label}
          </Badge>
        ) : null}
      </div>
      {caption ? <p className="mt-1.5 text-xs leading-snug text-muted">{caption}</p> : null}
    </>
  );

  // The reference's tile: a soft icon chip on the left, the label, the number
  // (with its delta) and the caption stacked to its right.
  const body = icon ? (
    <div className="flex items-center gap-3">
      <span
        className={cx(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl [&>svg]:h-5 [&>svg]:w-5',
          compact ? 'sm:h-11 sm:w-11' : 'sm:h-12 sm:w-12 sm:rounded-xl 2xl:h-14 2xl:w-14 2xl:rounded-2xl sm:[&>svg]:h-6 sm:[&>svg]:w-6',
          TONE_CHIP[tone],
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">{figure}</div>
    </div>
  ) : (
    figure
  );

  const skin =
    'rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors';
  const pad = compact ? 'sm:p-3.5' : 'sm:p-5';

  return href ? (
    <Link href={href} className={cx(skin, pad, 'block hover:bg-surface-hover', className)}>
      {body}
    </Link>
  ) : (
    <div className={cx(skin, pad, className)}>{body}</div>
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
