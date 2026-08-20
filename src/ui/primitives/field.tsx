import { cx, labelClass } from '../tokens';

/**
 * A labelled control, and the line of feedback underneath a form.
 *
 * `Field` renders the label element itself and expects the control as its
 * child, so the `htmlFor`/`id` pair can never drift apart — the single most
 * common reason a label stops being clickable.
 */

export function Field({
  label,
  htmlFor,
  hint,
  required,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor: string;
  hint?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
        {required ? <span className="ml-1 text-danger">*</span> : null}
      </label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-faint">{hint}</p> : null}
    </div>
  );
}

/**
 * The result of a submitted action.
 *
 * `role="status"` is not decoration: a form that reports success only by
 * colour reports nothing at all to a screen reader.
 */
export function FormMessage({
  status,
  message,
  className,
}: {
  status: 'idle' | 'error' | 'success' | string;
  message?: string | null;
  className?: string;
}) {
  if (status === 'idle' || !message) return null;
  const bad = status === 'error';
  return (
    <p
      role="status"
      className={cx(
        'flex items-start gap-1.5 text-[13px] leading-relaxed',
        bad ? 'text-danger' : 'text-success',
        className,
      )}
    >
      <span aria-hidden className="mt-[2px] text-[10px]">
        {bad ? '●' : '✓'}
      </span>
      <span>{message}</span>
    </p>
  );
}

/** A read-only label/value pair — the spine of every detail screen. */
export function DetailRow({
  label,
  value,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5',
        className,
      )}
    >
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function DetailList({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <dl className={cx('divide-y divide-line', className)}>{children}</dl>;
}
