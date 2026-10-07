import type { createAdminClient } from '@/lib/db/admin';

/**
 * P1-DOD-064: inbound rate limiting for the routes that answer anyone (provider webhooks, the one-click unsubscribe, the landing-page route).
 *
 * The counter is `core.rate_limit_hit` in Postgres (supabase/migrations/20261124300000_...): a per-process memory counter on a serverless deployment limits
 * nothing, because every request can be a new process. The key is hashed in the database, so an address is never stored.
 *
 * FAILS OPEN, and says so: if the counter cannot be reached the request goes through and the log carries `degraded: true`. A limiter outage must not turn
 * into a provider's webhook being dropped; the signature or token check behind it is still the authority.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type RateLimitInput = { bucket: string; key: string; limit: number; windowSeconds: number };
export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number; degraded: boolean };

/** The caller's address as the platform's proxy reports it. Unknown callers share one key, which only makes the limit stricter, never looser. */
export function clientKeyFrom(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function hitRateLimit(admin: Admin, input: RateLimitInput): Promise<RateLimitDecision> {
  try {
    // db:types is generated from a running database; until it is regenerated this door is called through a loose view of the client
    const core = admin.schema('core') as unknown as {
      rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
    };
    const { data, error } = await core.rpc('rate_limit_hit', {
      p_bucket: input.bucket,
      p_key: input.key,
      p_limit: input.limit,
      p_window_seconds: input.windowSeconds,
    });
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'rate-limit', bucket: input.bucket, degraded: true, detail: error.message }));
      return { allowed: true, retryAfterSeconds: 0, degraded: true };
    }
    const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; retry_after_seconds?: number } | null | undefined;
    if (!row || typeof row.allowed !== 'boolean') {
      console.error(JSON.stringify({ level: 'error', scope: 'rate-limit', bucket: input.bucket, degraded: true, detail: 'rate_limit_hit answered nothing' }));
      return { allowed: true, retryAfterSeconds: 0, degraded: true };
    }
    return { allowed: row.allowed, retryAfterSeconds: row.retry_after_seconds ?? 60, degraded: false };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'rate-limit', bucket: input.bucket, degraded: true, detail: e instanceof Error ? e.message : 'unknown' }));
    return { allowed: true, retryAfterSeconds: 0, degraded: true };
  }
}

/** A 429 that tells the caller when to come back. Nothing about the limit's size or the key is revealed. */
export function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ ok: false, error: 'too many requests' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, Math.trunc(retryAfterSeconds))) },
  });
}

/** One call for a route: `const blocked = await limitPublicRoute(request, createAdminClient(), 'webhook-whatsapp', 1200, 60); if (blocked) return blocked;` */
export async function limitPublicRoute(
  request: { headers: { get(name: string): string | null } },
  admin: Admin,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const decision = await hitRateLimit(admin, { bucket, key: clientKeyFrom(request.headers), limit, windowSeconds });
  return decision.allowed ? null : tooManyRequests(decision.retryAfterSeconds);
}
