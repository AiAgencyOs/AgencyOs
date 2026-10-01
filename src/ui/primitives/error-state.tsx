import { cx } from '../tokens';
import { IconAlert } from '../icons';

/**
 * The screen (or panel) that could not be built — the PDF §8's "error state",
 * beside the empty and loading states. An empty list says "nothing here"; this
 * says "we could not read it", which is a different and worse claim that a
 * reader must never mistake for the first (G-054).
 *
 * Like `EmptyState` it takes its retry as `action`, so a server component can
 * render it and a client error boundary can hand it a `reset` button. It
 * deliberately says nothing about the cause: the detail is in the log.
 */
export function ErrorState({
  title = 'This could not be loaded',
  description = 'Something it needed could not be read. Nothing has been changed — this is a display problem, not a lost record.',
  action,
  digest,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** The error boundary's digest, to quote when reporting it. */
  digest?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={cx('flex flex-col items-start gap-3 rounded-2xl border border-line bg-surface p-6 shadow-sm', className)}>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft text-danger">
        <IconAlert size={20} />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-[13px] leading-relaxed text-muted">{description}</p>
      </div>
      {action || digest ? (
        <div className="flex flex-wrap items-center gap-3">
          {action}
          {digest ? <span className="font-mono text-xs text-faint">{digest}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
