/** The default page size for a list screen that has none of its own reason to differ. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Slices an already-fetched array into one page, clamping the requested page
 * into range first — a stale `?page=` link (a filter narrowed the list, or
 * someone typed a number past the end) must land on the last real page, not
 * render an empty table while `rows.length` still says there's data.
 *
 * Pure and JSX-free on purpose: `pagination.tsx` re-exports it, but keeping
 * the logic itself in a `.ts` file is what lets a unit test import it
 * directly (the test runner strips TypeScript types but does not compile
 * JSX, so a `.tsx` module cannot be `import`ed from a test).
 */
export function paginate<T>(
  rows: readonly T[],
  requestedPage: number,
  pageSize: number,
): { page: number; pageCount: number; rows: T[] } {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (page - 1) * pageSize;
  return { page, pageCount, rows: rows.slice(start, start + pageSize) };
}
