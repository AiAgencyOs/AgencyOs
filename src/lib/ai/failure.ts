import type { AppError } from '@/lib/errors';
import { err, type Result } from '@/lib/result';

/**
 * Why a model call failed, in the one distinction the router needs.
 *
 * `unavailable` — THIS vendor, key or model cannot serve the call right now:
 * rate limited, a 5xx, a timeout, a dropped connection, a key that was
 * rejected or may not use the model, a model that does not exist. Another
 * model might serve it, so the router may try the next candidate.
 *
 * Everything else — a refusal, an exhausted output budget, output that is not
 * valid JSON, a 400 naming a field — is about THE REQUEST or what came back,
 * and the same request would fail the same way elsewhere. Those never fall
 * back: a fallback that papers over a malformed request or a refusal would
 * move a client's conversation to a second vendor for nothing.
 *
 * Carried in `details.failure` because `AppError` already has a typed slot for
 * extra detail and every adapter already returns `Result`. No message is
 * parsed anywhere: the adapter that knows the cause says so.
 */
const KEY = 'failure';
const UNAVAILABLE = 'unavailable';

export function providerUnavailable<T = never>(message: string): Result<T> {
  return err('PROVIDER_ERROR', message, { details: { [KEY]: [UNAVAILABLE] } });
}

export function isProviderUnavailable(error: AppError): boolean {
  return error.details?.[KEY]?.includes(UNAVAILABLE) === true;
}

/** HTTP statuses that mean "this vendor/key/model cannot serve it", not "your request is wrong". */
export function isUnavailableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}
