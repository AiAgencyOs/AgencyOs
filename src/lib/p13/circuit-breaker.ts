import type { createAdminClient } from '@/lib/db/admin';

import { type CanonicalErrorCode } from './canonical-errors';

/**
 * P1-MP3-035 / P1-API-021: a per-organization, per-provider circuit breaker whose state lives in Postgres (`core.p13_circuit_breakers`), because a
 * per-process breaker on a serverless deployment is a different breaker on every request.
 *
 *   admit  -> closed: go. open: held out (retryAfterSeconds says when). After the cool-down exactly ONE caller is admitted as the probe.
 *   record -> a good call closes it; counted failures open it at the threshold; invalid credentials open it at once; a failed probe re-opens it.
 *
 * This wrapper NEVER retries. Retrying is the caller's decision under spec section 20: a financial or destructive operation must not be blindly
 * replayed, so the wrapper surfaces the failure once and the circuit only decides whether the NEXT call is attempted.
 *
 * If the breaker cannot be reached the call goes through (`degraded: true`): losing the breaker must not become losing the provider.
 */
type Admin = ReturnType<typeof createAdminClient>;
type Rpc = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };

export type Admission = { admitted: boolean; state: 'closed' | 'open' | 'half_open' | 'unknown'; retryAfterSeconds: number; degraded: boolean };

export async function admitCall(admin: Admin, organizationId: string, provider: string): Promise<Admission> {
  try {
    const core = admin.schema('core') as unknown as Rpc;
    const { data, error } = await core.rpc('p13_circuit_admit', { p_organization_id: organizationId, p_provider: provider });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { admitted?: boolean; state?: string; retry_after_seconds?: number } | null | undefined;
    if (!row || typeof row.admitted !== 'boolean') throw new Error('p13_circuit_admit answered nothing');
    return { admitted: row.admitted, state: (row.state as Admission['state']) ?? 'unknown', retryAfterSeconds: row.retry_after_seconds ?? 0, degraded: false };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'circuit-breaker', provider, degraded: true, detail: e instanceof Error ? e.message : 'unknown' }));
    return { admitted: true, state: 'unknown', retryAfterSeconds: 0, degraded: true };
  }
}

export async function recordCall(admin: Admin, organizationId: string, provider: string, outcome: { ok: true } | { ok: false; errorClass: CanonicalErrorCode }): Promise<void> {
  try {
    const core = admin.schema('core') as unknown as Rpc;
    const { error } = await core.rpc('p13_circuit_record', {
      p_organization_id: organizationId,
      p_provider: provider,
      p_ok: outcome.ok,
      p_error_class: outcome.ok ? null : outcome.errorClass,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'circuit-breaker', provider, degraded: true, detail: e instanceof Error ? e.message : 'unknown' }));
  }
}

export type GuardedResult<T> = { ran: true; value: T } | { ran: false; circuit: 'open' | 'half_open'; retryAfterSeconds: number };

/**
 * Run `call` under the breaker. `call` returns `{ ok: true, value }` or `{ ok: false, errorClass }`: it classifies its own failure (see
 * `classifyFailure`), so the breaker never parses a message. A thrown exception is recorded as UNKNOWN_ERROR and re-thrown.
 */
export async function withCircuit<T>(
  admin: Admin,
  organizationId: string,
  provider: string,
  call: () => Promise<{ ok: true; value: T } | { ok: false; errorClass: CanonicalErrorCode; value?: T }>,
): Promise<GuardedResult<{ ok: true; value: T } | { ok: false; errorClass: CanonicalErrorCode; value?: T }>> {
  const admission = await admitCall(admin, organizationId, provider);
  if (!admission.admitted) return { ran: false, circuit: admission.state === 'half_open' ? 'half_open' : 'open', retryAfterSeconds: admission.retryAfterSeconds };
  let result: Awaited<ReturnType<typeof call>>;
  try {
    result = await call();
  } catch (e) {
    await recordCall(admin, organizationId, provider, { ok: false, errorClass: 'UNKNOWN_ERROR' });
    throw e;
  }
  await recordCall(admin, organizationId, provider, result.ok ? { ok: true } : { ok: false, errorClass: result.errorClass });
  return { ran: true, value: result };
}
