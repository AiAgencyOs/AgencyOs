import { cx, TONE_DOT, type Tone } from '../tokens';

/**
 * A horizontal progress bar with the percentage beside it — the reference's
 * project-progress vocabulary (Active Projects table, Project header, Kanban
 * cards). The number is always printed; the bar alone is colour-only.
 */
export function ProgressBar({
  value,
  tone = 'success',
  label,
  showValue = true,
  size = 'md',
  className,
}: {
  /** 0–100. Clamped. */
  value: number;
  tone?: Tone;
  /** What the percentage is of — read by assistive tech. */
  label?: string;
  showValue?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-2', className)}>
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className={cx('relative block min-w-0 flex-1 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-line', size === 'sm' ? 'h-1.5' : 'h-2')}
      >
        <span className={cx('absolute inset-y-0 left-0 rounded-full', TONE_DOT[tone])} style={{ width: `${pct}%` }} />
      </span>
      {showValue ? <span className="tabular shrink-0 text-xs font-medium text-muted">{pct}%</span> : null}
    </span>
  );
}
