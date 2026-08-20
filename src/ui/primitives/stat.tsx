import Link from 'next/link';

import { cx, TONE_TEXT, type Tone } from '../tokens';

/**
 * A single number, with enough around it to be read correctly.
 *
 * The value is `tabular` so a column of figures lines up on the decimal, and
 * the caption is required-by-convention: a bare number on a dashboard is a
 * quiz, not a metric.
 */
export function Stat({
  label,
  value,
  caption,
  tone = 'neutral',
  icon,
  href,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  caption?: React.ReactNode;
  tone?: Tone;
  icon?: React.ReactNode;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
        {icon ? <span className={cx('shrink-0', TONE_TEXT[tone])}>{icon}</span> : null}
      </div>
      <p
        className={cx(
          'tabular mt-2 text-2xl font-semibold leading-none tracking-tight sm:text-[28px]',
          tone === 'neutral' ? 'text-foreground' : TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
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

/**
 * The row of metrics at the top of a screen.
 *
 * Two columns on a phone rather than one: these numbers are short, and a
 * single column pushes the actual content of the page below the fold.
 */
export function StatGrid({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>{children}</div>
  );
}
