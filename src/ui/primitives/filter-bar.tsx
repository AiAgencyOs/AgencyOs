import Link from 'next/link';

import { cx, inputClass } from '../tokens';

/**
 * The filter row every list screen needs: free-text search, a rail of status
 * chips, and room for a select or two. Deliberately built on GET forms and
 * `<Link>`s rather than client-side state — the audit log page proved the
 * pattern first (search param in, filtered server render out), and a filter
 * that round-trips through the URL is one a user can bookmark, share, or hit
 * back on, which a `useState` filter never is.
 */
export function FilterBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center', className)}>
      {children}
    </div>
  );
}

/**
 * A search box that submits to `action` (typically the current path) as a
 * GET, so the query lands in `?<name>=` for the server component to read.
 * Any other active filters must be passed as `preserve` or they're dropped
 * on submit — a plain HTML form only sends its own fields.
 */
export function FilterSearch({
  action,
  name = 'q',
  defaultValue,
  placeholder = 'Search…',
  preserve,
  className,
}: {
  action: string;
  name?: string;
  defaultValue?: string;
  placeholder?: string;
  /** Other active search params to carry through as hidden fields. */
  preserve?: Record<string, string | undefined>;
  className?: string;
}) {
  return (
    <form action={action} method="GET" className={cx('min-w-[200px] flex-1', className)}>
      {preserve
        ? Object.entries(preserve).map(([key, value]) =>
            value && key !== name ? <input key={key} type="hidden" name={key} value={value} /> : null,
          )
        : null}
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={inputClass}
      />
    </form>
  );
}

export type FilterChipOption = {
  key: string;
  label: React.ReactNode;
  href: string;
  active: boolean;
};

/**
 * A horizontally-scrolling rail of status/category chips — the audit log's
 * filter rail, generalised. Scrolls sideways on a narrow screen rather than
 * wrapping, so a long option list never pushes the content below the fold.
 */
export function FilterChips({
  options,
  className,
}: {
  options: FilterChipOption[];
  className?: string;
}) {
  return (
    <div className={cx('no-scrollbar flex shrink-0 gap-2 overflow-x-auto', className)}>
      {options.map((o) => (
        <Link key={o.key} href={o.href} className={filterChipClass(o.active)}>
          {o.label}
        </Link>
      ))}
    </div>
  );
}

export function filterChipClass(active: boolean): string {
  return cx(
    'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
    active
      ? 'bg-brand text-brand-fg'
      : 'bg-surface text-muted ring-1 ring-inset ring-line hover:text-foreground',
  );
}
