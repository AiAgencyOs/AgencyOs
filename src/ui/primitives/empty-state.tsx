import { cx } from '../tokens';

/**
 * The screen with nothing on it.
 *
 * An empty list should say why it is empty and what fills it. "No leads yet"
 * on its own leaves a reader unable to tell a working-but-idle system from a
 * broken one, and that ambiguity costs a support message every time.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface/50 px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? (
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-sunken text-muted">
          {icon}
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** A short inline notice — context a page owes the reader before they act. */
export function Callout({
  tone = 'info',
  icon,
  title,
  className,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  icon?: React.ReactNode;
  title?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  const skin = {
    info: 'border-info/25 bg-info-soft text-info',
    warning: 'border-warning/30 bg-warning-soft text-warning',
    danger: 'border-danger/25 bg-danger-soft text-danger',
    success: 'border-success/25 bg-success-soft text-success',
  }[tone];

  return (
    <div className={cx('flex gap-2.5 rounded-lg border px-3.5 py-3', skin, className)}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 text-[13px] leading-relaxed">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? 'mt-0.5 opacity-90' : 'opacity-90'}>{children}</div> : null}
      </div>
    </div>
  );
}
