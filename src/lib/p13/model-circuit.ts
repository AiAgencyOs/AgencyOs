import type { createAdminClient } from '@/lib/db/admin';
import { failureKindOf, isProviderUnavailable, providerUnavailable } from '@/lib/ai/failure';
import type { Result } from '@/lib/result';

import { classifyFailure } from './canonical-errors';
import { withCircuit } from './circuit-breaker';

/**
 * W5 wiring: one outbound model call, run under the per-organization, per-provider circuit breaker (P1-MP3-035).
 *
 * The success path is unchanged: the adapter's own `Result` is returned as it came. The breaker only
 *   - counts a failure that says THIS vendor cannot serve the call right now (`isProviderUnavailable`: 5xx, timeout, network, rate limit, bad key); a
 *     refusal or a malformed request is not the provider's fault and is recorded as a healthy call;
 *   - refuses the call, before any request leaves, while the circuit is open, and says so as a `providerUnavailable` result, which is exactly the
 *     class the router already falls back on, so an open circuit moves the work to the next candidate instead of waiting on a dead vendor.
 *
 * A breaker that cannot be reached lets the call through (see `circuit-breaker.ts`).
 */
type Admin = ReturnType<typeof createAdminClient>;

export async function callThroughCircuit<T>(admin: Admin, organizationId: string, providerId: string, call: () => Promise<Result<T>>): Promise<Result<T>> {
  const guarded = await withCircuit<Result<T>>(admin, organizationId, providerId, async () => {
    const result = await call();
    if (result.ok || !isProviderUnavailable(result.error)) return { ok: true, value: result };
    return { ok: false, errorClass: classifyFailure({ kind: failureKindOf(result.error) }), value: result };
  });
  if (!guarded.ran) {
    return providerUnavailable(`The ${providerId} circuit is ${guarded.circuit.replace('_', '-')}; retry in about ${guarded.retryAfterSeconds}s.`, 'server');
  }
  const inner = guarded.value.value;
  if (!inner) throw new Error('circuit wrapper lost the provider result');
  return inner;
}
