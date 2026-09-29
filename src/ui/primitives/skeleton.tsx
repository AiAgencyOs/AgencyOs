import { cx } from '../tokens';

/**
 * The screen before there is anything to show.
 *
 * Next's file-based `loading.tsx` swaps this in while a server component
 * streams, so the shapes here echo the page's eventual layout (a header, a
 * stat row, a table) rather than a generic spinner — the page-5 shared rule
 * asks for a "loading skeleton", not a loading notice.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-surface-sunken', className)} />;
}

export function SkeletonStatGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="border-b border-line bg-surface-sunken px-4 py-2.5">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="flex flex-col divide-y divide-line">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The common shape: a header, a stat row, then a table — most list screens. */
export function SkeletonPage({ statCount = 4, rows = 6 }: { statCount?: number; rows?: number }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <SkeletonStatGrid count={statCount} />
      <SkeletonTable rows={rows} />
    </div>
  );
}
