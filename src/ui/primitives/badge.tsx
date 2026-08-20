import { cx, humanize, statusTone, TONE_CHIP, TONE_DOT, type Tone } from '../tokens';

/**
 * A chip. `Badge` when you know the tone, `StatusBadge` when you have a domain
 * status and want the product's one opinion about what colour it is.
 */

export function Badge({
  tone = 'neutral',
  dot,
  mono,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        mono && 'font-mono',
        TONE_CHIP[tone],
        className,
      )}
    >
      {dot ? <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} /> : null}
      {children}
    </span>
  );
}

export function StatusBadge({
  status,
  dot = true,
  raw,
  className,
}: {
  status: string | null | undefined;
  dot?: boolean;
  /** Show the stored value verbatim instead of prose — for audit-style screens. */
  raw?: boolean;
  className?: string;
}) {
  if (!status) return <span className="text-muted">—</span>;
  return (
    <Badge tone={statusTone(status)} dot={dot} mono={raw} className={className}>
      {raw ? status : humanize(status)}
    </Badge>
  );
}
