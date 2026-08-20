'use client';

import { buttonClass, IconAlert, IconRefresh } from '@/ui';

/**
 * What the internal application shows when a page cannot be built.
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
export default function InternalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-4">
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft text-danger">
          <IconAlert size={20} />
        </span>
        <h1 className="text-lg font-semibold tracking-tight">This page could not be loaded</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Something it needed could not be read. Nothing has been changed — this is a display
          problem, not a lost record.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={reset} className={buttonClass('primary', 'md')}>
            <IconRefresh size={15} />
            Try again
          </button>
          {error.digest ? (
            <span className="font-mono text-xs text-faint">{error.digest}</span>
          ) : null}
        </div>
      </div>
    </main>
  );
}
