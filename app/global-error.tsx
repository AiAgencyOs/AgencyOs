'use client';

import './globals.css';

/**
 * The last boundary — what the browser shows when the ROOT layout itself
 * cannot render (bucket F, the shared rule's "error boundary with
 * reference"). `app/(internal)/error.tsx` catches a page that failed inside
 * the shell; this catches the shell failing, which is why it must render
 * its own <html> and <body> and cannot import anything that might be the
 * thing that broke. Plain elements and the stylesheet only.
 *
 * Says nothing about the cause: the detail is in the log under the digest,
 * and what a person needs on screen is that nothing was changed and that
 * trying again is worth it — with the reference to quote.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4">
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-danger">AgencyOS</p>
            <h1 className="mt-2 text-lg font-semibold tracking-tight text-foreground">The application could not be loaded</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Something the whole panel needs could not be read or rendered. Nothing has been changed — this is a display
              problem, not a lost record.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-9 items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-fg hover:opacity-90"
              >
                Try again
              </button>
              <a href="/dashboard" className="text-[13px] font-medium text-muted underline underline-offset-2 hover:text-foreground">
                Back to the Command Center
              </a>
              {error.digest ? <span className="font-mono text-xs text-faint">ref {error.digest}</span> : null}
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
