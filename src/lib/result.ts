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
