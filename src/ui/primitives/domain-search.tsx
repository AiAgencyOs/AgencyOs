import Link from 'next/link';

import { buttonClass, cx, inputClass } from '../tokens';

/**
 * Search within a domain — the shared rule (PDF §3): every list screen that
 * can grow carries one search box that submits as a GET to its own path, so
 * the query lands in `?q=` for the server component to read and hand to its
 * reader, which filters server-side. Any other active filters are carried
 * through as hidden fields — a plain HTML form only sends its own.
 *
 * The leads, clients and quotations pages each hand-rolled this; this is
 * the one component the rest of the domains mount (bucket G-3).
 */
export function DomainSearch({
  action,
  value,
  placeholder = 'Search…',
  label = 'Search',
  preserve,
  className,
}: {
  /** The list's own path, e.g. `/projects`. */
  action: string;
  /** The current `?q=`, so the box shows what is being searched. */
  value?: string;
  placeholder?: string;
  /** Accessible name for the input. */
  label?: string;
  /** Other active search params to carry through as hidden fields. */
  preserve?: Record<string, string | undefined>;
  className?: string;
}) {
  return (
    <form action={action} method="GET" role="search" className={cx('flex flex-wrap items-center gap-2', className)}>
      {preserve
        ? Object.entries(preserve).map(([key, v]) => (v && key !== 'q' && key !== 'page' ? <input key={key} type="hidden" name={key} value={v} /> : null))
        : null}
      <input type="search" name="q" defaultValue={value ?? ''} placeholder={placeholder} aria-label={label} maxLength={120} className={cx(inputClass, 'w-56')} />
      <button type="submit" className={buttonClass('secondary', 'sm')}>
        Search
      </button>
    </form>
  );
}

/**
 * The line under the search box once a query is active: "N results for
 * 'q'" with a link that clears only the query and keeps the other filters.
 * A count is a count — the caller passes the number the reader returned.
 */
export function SearchSummary({ q, count, clearHref, bounded }: { q: string; count: number; clearHref: string; bounded?: boolean }) {
  if (!q) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
      <span>
        {bounded ? 'At least ' : ''}
        {count} result{count === 1 ? '' : 's'} for &lsquo;{q}&rsquo;
      </span>
      <Link href={clearHref} className="text-xs font-medium text-brand underline-offset-2 hover:underline">
        Clear search
      </Link>
    </p>
  );
}
