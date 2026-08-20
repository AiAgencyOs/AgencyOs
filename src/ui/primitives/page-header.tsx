import { cx } from '../tokens';

/**
 * The top of a page: what this screen is, and the controls that act on all of
 * it. Every page uses it, so a reader always finds the title, the count and
 * the primary action in the same three places.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Chips that qualify the title — counts, states, the tenant it belongs to. */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {meta ? <div className="flex flex-wrap items-center gap-2">{meta}</div> : null}
    </header>
  );
}
