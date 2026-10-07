import { NextResponse } from 'next/server';

import { httpStatusFor, newCorrelationId, type ErrorCode } from '@/lib/errors';

/**
 * P1-DOD-061 — the one way a route answers a failure. Every `app/api/**` route builds its error responses here, so the body is always
 * `{ error, code, correlationId }`: `error` is the human sentence the route always sent (so nothing that read it breaks), `code` is one of the eight
 * application codes of `src/lib/errors.ts`, and `correlationId` ties the answer to the logs. The status defaults to the code's status; a route that
 * historically answered with a different one (a 503 for an unreadable store, a 413 for a body too large) passes it, so no status changes.
 *
 * A route never writes `NextResponse.json({ error: ... })` by hand: `tests/p13-route-errors-and-crm-export.test.ts` fails if one does.
 */
export type RouteErrorOptions = {
  status?: number;
  headers?: HeadersInit;
  correlationId?: string;
  /** Extra keys some callers read (`ok: false`, a refusal `reason`). They never replace `error`, `code` or `correlationId`. */
  extra?: Record<string, unknown>;
};

export function routeError(code: ErrorCode, message: string, options: RouteErrorOptions = {}): NextResponse {
  const correlationId = options.correlationId ?? newCorrelationId();
  return NextResponse.json(
    { ...(options.extra ?? {}), error: message, code, correlationId },
    { status: options.status ?? httpStatusFor(code), ...(options.headers ? { headers: options.headers } : {}) },
  );
}

/** The application code that best names an HTTP status a route already answers with. */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502) return 'PROVIDER_ERROR';
  if (status >= 500) return 'INTERNAL';
  return 'VALIDATION';
}
