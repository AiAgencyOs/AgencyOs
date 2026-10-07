import type { ErrorCode } from '@/lib/errors';

/**
 * P1-API-022 / P1-MP3-038 / P1-DOD-061: the twelve canonical errors of the Technical / API / Data Contract Specification section 21, and the one place
 * a provider's answer is mapped onto them BEFORE a workflow decides anything (retry, fall back, open a circuit, escalate).
 *
 * `src/lib/errors.ts` keeps its eight application codes (they are the shape every route already returns). This file is the provider-facing vocabulary
 * and says how each canonical code lands on an application code, whether it may be retried, and whether it counts toward opening a circuit. The last
 * rule is mirrored in SQL (`core.p13_error_counts_toward_circuit`); tests/p13-canonical-errors.test.ts pins the two lists to each other.
 */
export const CANONICAL_ERROR_CODES = [
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'NOT_FOUND',
  'CONFLICT_DUPLICATE',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
  'POLICY_BLOCKED',
  'UNKNOWN_ERROR',
] as const;

export type CanonicalErrorCode = (typeof CANONICAL_ERROR_CODES)[number];

export function isCanonicalErrorCode(value: unknown): value is CanonicalErrorCode {
  return typeof value === 'string' && (CANONICAL_ERROR_CODES as readonly string[]).includes(value);
}

/** How each canonical code lands on the eight codes every route already returns. */
export const APP_CODE_FOR: Record<CanonicalErrorCode, ErrorCode> = {
  AUTHENTICATION_ERROR: 'PROVIDER_ERROR',
  AUTHORIZATION_ERROR: 'FORBIDDEN',
  VALIDATION_ERROR: 'VALIDATION',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'PROVIDER_ERROR',
  PROVIDER_UNAVAILABLE: 'PROVIDER_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT_DUPLICATE: 'CONFLICT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NETWORK_ERROR: 'PROVIDER_ERROR',
  POLICY_BLOCKED: 'FORBIDDEN',
  UNKNOWN_ERROR: 'INTERNAL',
};

/** Spec section 20: permanent errors and bad credentials are never retried; an unknown failure is retried only when the operation says it is safe. */
const RETRYABLE: ReadonlySet<CanonicalErrorCode> = new Set(['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR', 'NETWORK_ERROR']);

export function isRetryable(code: CanonicalErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** A caller-fault answer says nothing about the provider's health. Mirrors `core.p13_error_counts_toward_circuit`. */
const CALLER_FAULT: ReadonlySet<CanonicalErrorCode> = new Set(['VALIDATION_ERROR', 'AUTHORIZATION_ERROR', 'NOT_FOUND', 'CONFLICT_DUPLICATE', 'POLICY_BLOCKED']);

export function countsTowardCircuit(code: CanonicalErrorCode): boolean {
  return !CALLER_FAULT.has(code);
}

export type FailureEvidence = {
  /** HTTP status of the provider's answer, when it answered. */
  status?: number | null;
  /** `src/lib/ai/failure.ts` kind, when the adapter knew the cause. */
  kind?: 'auth' | 'rate_limit' | 'model_missing' | 'server' | 'timeout' | 'network' | null;
  /** An abort / timeout signalled by the runtime rather than by the provider. */
  aborted?: boolean;
  /** A policy or business rule refused the operation before any provider was asked. */
  policyBlocked?: boolean;
  /** The request or the provider's result failed our schema. */
  invalidShape?: boolean;
};

/**
 * Classify a failure from evidence the caller already has. No message text is parsed: the adapter that knows the cause says so (`kind`), otherwise the
 * HTTP status decides, otherwise the failure is UNKNOWN_ERROR, which callers must treat as "handle safely" (spec section 21), not as "retry".
 */
export function classifyFailure(evidence: FailureEvidence): CanonicalErrorCode {
  if (evidence.policyBlocked) return 'POLICY_BLOCKED';
  if (evidence.invalidShape) return 'VALIDATION_ERROR';
  if (evidence.aborted) return 'TIMEOUT';
  switch (evidence.kind) {
    case 'auth':
      return 'AUTHENTICATION_ERROR';
    case 'rate_limit':
      return 'RATE_LIMITED';
    case 'model_missing':
      return 'NOT_FOUND';
    case 'server':
      return 'PROVIDER_UNAVAILABLE';
    case 'timeout':
      return 'TIMEOUT';
    case 'network':
      return 'NETWORK_ERROR';
    default:
      break;
  }
  const s = evidence.status;
  if (typeof s !== 'number') return 'UNKNOWN_ERROR';
  if (s === 401) return 'AUTHENTICATION_ERROR';
  if (s === 403) return 'AUTHORIZATION_ERROR';
  if (s === 404 || s === 410) return 'NOT_FOUND';
  if (s === 408 || s === 504) return 'TIMEOUT';
  if (s === 409) return 'CONFLICT_DUPLICATE';
  if (s === 400 || s === 422) return 'VALIDATION_ERROR';
  if (s === 429) return 'RATE_LIMITED';
  if (s === 502 || s === 503) return 'PROVIDER_UNAVAILABLE';
  if (s >= 500) return 'PROVIDER_ERROR';
  if (s >= 400) return 'VALIDATION_ERROR';
  return 'UNKNOWN_ERROR';
}

/**
 * Seconds to wait before retrying, honouring the provider's Retry-After (either delta-seconds or an HTTP date), clamped. `fallback` applies when the
 * provider said nothing usable. Never negative, never longer than `maxSeconds`.
 */
export function retryAfterSeconds(header: string | null | undefined, now: Date, fallback: number, maxSeconds = 3600): number {
  const clamp = (n: number) => Math.min(Math.max(Math.ceil(n), 1), maxSeconds);
  const raw = header?.trim();
  if (!raw) return clamp(fallback);
  if (/^\d+$/.test(raw)) return clamp(Number(raw));
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return clamp(fallback);
  return clamp((at - now.getTime()) / 1000);
}
