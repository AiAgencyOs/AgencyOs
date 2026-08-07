import { NextResponse } from 'next/server';

import { clientEnv } from '@/lib/env';
import { newCorrelationId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 5_000;

type CheckResult = {
  ok: boolean;
  latencyMs: number;
  detail?: string;
};

/**
 * Probes PostgREST's root endpoint. PostgREST holds a live connection pool to
 * Postgres and returns 5xx when the database is unreachable, so a 200 here
 * means both the API layer and Postgres are healthy.
 */
async function checkDatabase(): Promise<CheckResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${clientEnv.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const latencyMs = Math.round(performance.now() - started);
    return res.ok
      ? { ok: true, latencyMs }
      : { ok: false, latencyMs, detail: `PostgREST returned ${res.status}` };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : 'unreachable',
    };
  }
}

async function checkAuth(): Promise<CheckResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${clientEnv.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const latencyMs = Math.round(performance.now() - started);
    return res.ok
      ? { ok: true, latencyMs }
      : { ok: false, latencyMs, detail: `Auth returned ${res.status}` };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : 'unreachable',
    };
  }
}

/**
 * GET /api/health
 *
 * Liveness + dependency check. Returns 200 when every dependency is reachable,
 * 503 otherwise, so a platform health check can act on it directly.
 */
export async function GET() {
  const correlationId = newCorrelationId();

  const [database, auth] = await Promise.all([checkDatabase(), checkAuth()]);
  const healthy = database.ok && auth.ok;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checks: { database, auth },
      correlationId,
      timestamp: new Date().toISOString(),
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
