import { cardClass, cx } from '../tokens';

/**
 * A card, and the header that goes on top of it.
 *
 * `Card` is the only container in the product with a border and a shadow.
 * Nesting one inside another is deliberately ugly, because a card inside a
 * card is nearly always a section that wanted a heading instead.
 */

export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(cardClass, 'overflow-hidden', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? <span className="mt-0.5 shrink-0 text-muted">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('px-4 py-4 sm:px-5', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        'flex flex-wrap items-center gap-3 border-t border-line bg-surface-sunken px-4 py-3 sm:px-5',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A titled band inside a card — for grouping controls without nesting cards. */
export function Section({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cx('flex flex-col gap-3', className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{title}</h3>
            {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
