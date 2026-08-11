'use client';

/**
 * What the client portal shows when a page cannot be built.
 *
 * Gap G-054. Every reader in a `queries.ts` used to swallow its error and
 * return an empty list, so a database that did not answer rendered as a page
 * with nothing on it — "no invoices", "no leads" — which is a statement about
 * the business, and it was false. Those readers now throw, and this is where
 * that lands.
 *
 * Deliberately says nothing about the cause. The detail is in the log, under
 * the scope of the read that failed; what is useful on screen is that the page
 * is wrong rather than empty, and that trying again is worth it.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center gap-4 px-6">
      <h1 className="text-lg font-semibold tracking-tight">This page could not be loaded</h1>
      <p className="text-sm text-black/70 dark:text-white/70">
        Something it needed could not be read. Nothing has been changed — this is a display
        problem, not a lost record.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          Try again
        </button>
        {error.digest ? (
          <span className="font-mono text-xs text-black/50 dark:text-white/50">
            {error.digest}
          </span>
        ) : null}
      </div>
    </main>
  );
}
