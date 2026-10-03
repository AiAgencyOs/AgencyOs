'use client';

import { buttonClass, ErrorState, IconRefresh } from '@/ui';

/**
 * What the internal application shows when a page cannot be built.
 *
 * Gap G-054. Every reader in a `queries.ts` used to swallow its error and
 * return an empty list, so a database that did not answer rendered as a page
 * with nothing on it — "no invoices", "no leads" — which is a statement about
 * the business, and it was false. Those readers now throw, and this is where
 * that lands — through the shared `ErrorState`, so every error in the panel
 * reads the same.
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
      <ErrorState
        title="This page could not be loaded"
        digest={error.digest}
        action={
          <button type="button" onClick={reset} className={buttonClass('primary', 'md')}>
            <IconRefresh size={15} />
            Try again
          </button>
        }
      />
    </main>
  );
}
