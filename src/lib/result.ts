import { appError, type AppError, type ErrorCode } from './errors';

/**
 * Services return Result<T> and do not throw for *expected* failures.
 * Unexpected failures still throw and are converted at the boundary.
 * See ARCHITECTURE.md §5.3.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err<T = never>(
  code: ErrorCode,
  message: string,
  options?: { details?: Record<string, string[]>; correlationId?: string },
): Result<T> {
  return { ok: false, error: appError(code, message, options) };
}

export function isOk<T>(r: Result<T>): r is { ok: true; data: T } {
  return r.ok;
}

/** Unwrap or throw. Use only where a failure genuinely is a bug. */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.data;
  throw new Error(`[${r.error.code}] ${r.error.message} (${r.error.correlationId})`);
}

/**
 * A read a page depends on, that could not be performed.
 *
 * Gap G-054. Every reader in a `queries.ts` used to log its error and return
 * `[]` or `null`, so a database that did not answer rendered as an empty list
 * or a missing record — "no invoices" for "no answer", and "lead not found"
 * for "the lead could not be read". The page looked calm and said something
 * untrue, which is the shape D3, D5 and D6 removed from the write paths.
 *
 * Reads that render are the one place throwing is the *right* answer rather
 * than a lazy one. There is no caller to hand a `Result` to — the caller is a
 * Server Component, and React already has the mechanism: the nearest
 * `error.tsx` boundary catches this and tells the operator the page could not
 * be loaded, with a retry. A `Result` here would mean every component
 * branching on a failure it can do nothing about.
 *
 * The message deliberately carries no database detail; the detail goes to the
 * log, under a scope, where it is diagnosable without being shown to whoever
 * is looking at the screen.
 */
export function unreadable(scope: string, error: { message: string }): never {
  console.error(JSON.stringify({ level: 'error', scope, detail: error.message }));
  throw new Error(`${scope} could not be read`);
}
