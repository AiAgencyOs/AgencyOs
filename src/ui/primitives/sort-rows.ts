import type { SortDirection } from './table';

/**
 * Orders an already-fetched array by whichever `sortKey` is active, using the
 * caller's own comparators — a page's "Amount" column knows it means
 * `total_minor`, and a shared table primitive has no business inventing that
 * mapping. `undefined` sortKey (or one with no matching comparator) returns
 * the rows in their original order — a stale `?sort=` naming a column that no
 * longer exists degrades to "unsorted", not a crash.
 *
 * Pure and JSX-free like `paginate.ts`, for the same reason: importable
 * directly from a unit test.
 */
export function sortRows<T>(
  rows: readonly T[],
  sortKey: string | undefined,
  direction: SortDirection,
  comparators: Record<string, (a: T, b: T) => number>,
): T[] {
  const comparator = sortKey ? comparators[sortKey] : undefined;
  if (!comparator) return [...rows];

  const sorted = [...rows].sort(comparator);
  return direction === 'desc' ? sorted.reverse() : sorted;
}
