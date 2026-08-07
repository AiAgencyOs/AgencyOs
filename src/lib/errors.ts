/**
 * The single error shape used across every module, Server Action, and route.
 * See ARCHITECTURE.md §5.3.
 */

export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type AppError = {
  code: ErrorCode;
  /** Safe to display to an end user. Never include secrets or SQL. */
  message: string;
  /** Field-level validation errors, keyed by field path. */
  details?: Record<string, string[]>;
  /** Ties a user-visible failure to server logs and the audit trail. */
  correlationId: string;
};

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export function appError(
  code: ErrorCode,
  message: string,
  options?: { details?: Record<string, string[]>; correlationId?: string },
): AppError {
  return {
    code,
    message,
    ...(options?.details ? { details: options.details } : {}),
    correlationId: options?.correlationId ?? newCorrelationId(),
  };
}

/**
 * Converts an unknown thrown value into an AppError without leaking internals
 * to the user. The original message goes to the logs, not the response.
 */
export function fromUnknown(err: unknown, correlationId = newCorrelationId()): AppError {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ level: 'error', correlationId, detail }));
  return {
    code: 'INTERNAL',
    message: 'Something went wrong. Please try again.',
    correlationId,
  };
}
