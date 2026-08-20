import Link from 'next/link';

import { cx } from '../tokens';
import { IconChevronRight } from '../icons';

/**
 * Tabular data, on a phone as well as on a desk.
 *
 * A table is the right shape for eight columns of records and the wrong shape
 * for a 390px screen, where it becomes a horizontal scroll nobody performs.
 * `DataTable` therefore takes the data and the column definitions rather than
 * markup, and renders **two** presentations from one description: a real
 * `<table>` from `md` up, and a stacked card list below it.
 *
 * Describing columns once is the point. The alternative — every page writing
 * its own table and its own mobile fallback — is how the two drift until the
 * phone view quietly stops showing a column that was added six months ago.
 */

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  /** The card's title on mobile. Give exactly one column this. */
  primary?: boolean;
  /** Sits beside the title on mobile instead of in the label list — for status chips. */
  badge?: boolean;
  /** Dropped entirely on mobile: detail that only earns its place on a wide screen. */
  desktopOnly?: boolean;
  /** Extra classes for the cell, e.g. `tabular` or `font-mono`. */
  cellClassName?: string;
  /** Keeps a column from wrapping to two lines in the desktop table. */
  width?: string;
};

export function DataTable<T>({
  rows,
  columns,
  getKey,
  href,
  className,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  getKey: (row: T) => string;
  /** When given, the whole row (and the whole mobile card) becomes one link. */
  href?: (row: T) => string;
  className?: string;
}) {
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const badges = columns.filter((c) => c.badge);
  const rest = columns.filter((c) => c !== primary && !c.badge && !c.desktopOnly);

  return (
    <div className={cx('min-w-0', className)}>
      {/* ── Desktop: a real table ─────────────────────────────────────── */}
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface shadow-xs md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-sunken">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={cx(
                    'px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap',
                    c.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {c.header}
                </th>
              ))}
              {href ? <th className="w-10" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const to = href?.(row);
              return (
                <tr
                  key={getKey(row)}
                  className="group border-b border-line transition-colors last:border-0 hover:bg-surface-hover"
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx(
                        'px-4 py-3 align-middle',
                        c.align === 'right' ? 'text-right' : 'text-left',
                        c.cellClassName,
                      )}
                    >
                      {/* One link per row, on the primary cell. A stretched
                          overlay would need `position: relative` on the `<tr>`,
                          which browsers treat inconsistently — and when it is
                          ignored the overlay sizes to the viewport instead,
                          swallowing every click on the page. The chevron below
                          is decoration, not a second tab stop. */}
                      {to && c === primary ? (
                        <Link href={to} className="font-medium text-foreground hover:text-brand">
                          {c.cell(row)}
                        </Link>
                      ) : (
                        c.cell(row)
                      )}
                    </td>
                  ))}
                  {href ? (
                    <td className="pr-3 text-right" aria-hidden>
                      <IconChevronRight
                        size={16}
                        className="inline text-faint transition-transform group-hover:translate-x-0.5"
                      />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Mobile: one card per record ───────────────────────────────── */}
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => {
          const to = href?.(row);
          const body = (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-foreground">
                  {primary ? primary.cell(row) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {badges.map((c) => (
                    <span key={c.key}>{c.cell(row)}</span>
                  ))}
                  {to ? <IconChevronRight size={16} className="text-faint" /> : null}
                </span>
              </div>
              {rest.length > 0 ? (
                <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  {rest.map((c) => (
                    <div key={c.key} className="contents">
                      <dt className="text-[11px] font-medium uppercase tracking-wider text-faint">
                        {c.header}
                      </dt>
                      <dd className={cx('min-w-0 text-right text-[13px]', c.cellClassName)}>
                        {c.cell(row)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </>
          );

          return (
            <li key={getKey(row)}>
              {to ? (
                <Link
                  href={to}
                  className="block rounded-xl border border-line bg-surface p-3.5 shadow-xs transition-colors active:bg-surface-hover"
                >
                  {body}
                </Link>
              ) : (
                <div className="rounded-xl border border-line bg-surface p-3.5 shadow-xs">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Escape hatch ─────────────────────────────────────────────────────────
   For the handful of tables whose shape is not "rows of one record" —
   matrices, grouped rows, footers with totals. Same visual grid, no opinion
   about the mobile presentation, so wrap it in `overflow-x-auto` yourself.
   ───────────────────────────────────────────────────────────────────────── */

export function TableFrame({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        '-mx-4 overflow-x-auto px-4 sm:mx-0 sm:rounded-xl sm:border sm:border-line sm:bg-surface sm:px-0 sm:shadow-xs',
        className,
      )}
    >
      <div className="min-w-max sm:min-w-0">{children}</div>
    </div>
  );
}

export function Th({
  className,
  children,
  align,
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={cx(
        'px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({
  className,
  children,
  align,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <td
      className={cx('px-4 py-3 align-middle', align === 'right' ? 'text-right' : '', className)}
      {...rest}
    >
      {children}
    </td>
  );
}
