import { cx } from '../tokens';
import { Avatar } from './avatar';

/**
 * The top of a 360 page — Project, Lead, Client, Invoice — as the reference
 * draws it: a logo tile, the name with its status chip on the same line, a
 * one-line subtitle, a row of icon-led facts (client, owner, start, due),
 * the actions on the right and, when the record has one, a progress figure.
 *
 * Nothing here reads data. Every fact is passed in by the page from the
 * readers it already has, so a header can never say something the page
 * below it would disagree with.
 */
export function EntityHeader({
  name,
  tile,
  status,
  subtitle,
  facts,
  actions,
  aside,
  children,
  className,
}: {
  name: string;
  /** What sits in the square tile: an avatar by default, or a custom node (a logo). */
  tile?: React.ReactNode;
  /** The chip beside the name — usually `<StatusBadge>`. */
  status?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Icon-led facts under the subtitle. */
  facts?: readonly EntityFact[];
  /** The buttons on the right. */
  actions?: React.ReactNode;
  /** A boxed figure at the far right — the reference's "53% Overall Progress" or "Next follow-up". */
  aside?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5', className)}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <span className="shrink-0">
            {tile ?? <Avatar name={name} size="xl" square tone="sidebar" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{name}</h1>
              {status}
            </div>
            {subtitle ? <p className="mt-0.5 text-[13px] text-muted sm:text-sm">{subtitle}</p> : null}
            {facts && facts.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                {facts.map((f) => (
                  <li key={f.label} className="flex min-w-0 items-center gap-2">
                    {f.icon ? (
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
                        {f.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-foreground">{f.value}</span>
                      <span className="block truncate text-[11px] text-muted">{f.label}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
        {actions || aside ? (
          <div className="flex shrink-0 flex-col items-stretch gap-3 sm:flex-row sm:items-start lg:flex-col lg:items-end">
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            {aside}
          </div>
        ) : null}
      </div>
      {children}
    </header>
  );
}

export type EntityFact = { label: string; value: React.ReactNode; icon?: React.ReactNode };

/** The boxed figure a header carries at its right — "53% · Overall progress". */
export function HeaderFigure({
  value,
  label,
  children,
  className,
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex min-w-[12rem] flex-col gap-1.5 rounded-lg border border-line bg-surface-sunken px-3 py-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="tabular text-lg font-semibold leading-none text-foreground">{value}</span>
        <span className="text-[11px] text-muted">{label}</span>
      </div>
      {children}
    </div>
  );
}
