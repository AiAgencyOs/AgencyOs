import Link from 'next/link';

import { cx } from '../tokens';
import { IconChevronLeft, IconChevronRight } from '../icons';

export { DEFAULT_PAGE_SIZE, paginate } from './paginate';

/**
 * Page-through for a list already read into memory.
 *
 * Every list reader in this app already caps its query (`listClients(limit=200)`
 * and siblings) rather than streaming an unbounded table, so paging here means
 * slicing that bounded array server-side by a `?page=` search param — not a
 * second round trip. `DataTable` itself stays a plain server-rendered
 * component (its `cell` functions cross no client boundary); this sits beside
 * it as plain `<Link>`s, so it needs no `'use client'` either.
 */
export function Pagination({
  page,
  pageCount,
  makeHref,
  className,
}: {
  /** 1-indexed current page. */
  page: number;
  pageCount: number;
  /** Builds the href for a given 1-indexed page number. */
  makeHref: (page: number) => string;
  className?: string;
}) {
  if (pageCount <= 1) return null;

  const prev = Math.max(1, page - 1);
  const next = Math.min(pageCount, page + 1);

  return (
    <nav
      aria-label="Pagination"
      className={cx('flex items-center justify-between gap-3 px-1 py-1', className)}
    >
      <PageLink href={makeHref(prev)} disabled={page <= 1} aria-label="Previous page">
        <IconChevronLeft size={16} />
        Previous
      </PageLink>
      <p className="text-[12.5px] text-muted">
        Page {page} of {pageCount}
      </p>
      <PageLink href={makeHref(next)} disabled={page >= pageCount} aria-label="Next page">
        Next
        <IconChevronRight size={16} />
      </PageLink>
    </nav>
  );
}

function PageLink({
  href,
  disabled,
  children,
  ...rest
}: { href: string; disabled: boolean; children: React.ReactNode } & React.AriaAttributes) {
  const cls = cx(
    'flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-medium transition-colors',
    disabled
      ? 'pointer-events-none text-faint opacity-50'
      : 'text-foreground hover:bg-surface-hover',
  );

  if (disabled) {
    return (
      <span className={cls} {...rest}>
        {children}
      </span>
    );
  }

  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}
