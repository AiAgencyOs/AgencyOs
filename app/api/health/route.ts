import { NextResponse } from 'next/server';

import { clientEnv } from '@/lib/env';
import { newCorrelationId } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 5_000;

type CheckResult = {
  ok: boolean;
  latencyMs: number;
  /** Which probe answered — see checkDatabase(). */
  probe?: 'rpc' | 'schema-cache';
  detail?: string;
};

const REST_HEADERS = {
  apikey: clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  Authorization: `Bearer ${clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
};

/**
 * Database health, with two probes of differing fidelity.
 *
 * 1. `rpc` — calls public.health_check(), which runs a real statement and so
 *    proves Postgres is actually serving queries. This is the probe we want.
 *
 * 2. `schema-cache` — fallback used until that function exists. Queries a
 *    sentinel table and treats PostgREST's "no such table" reply as healthy,
 *    which proves PostgREST is up and the API key is accepted, but NOT that
 *    Postgres is answering: that reply is served from an in-memory schema
 *    cache. Lower fidelity, and reported as such rather than glossed over.
 *
 * The route upgrades itself the moment Feature 2 (Database Schema) adds the
 * function — no change needed here.
 *
 * Note: we deliberately do not probe the `/rest/v1/` root. Under Supabase's
 * current API-key model that endpoint accepts secret keys only, so it 401s for
 * a publishable key even when the database is perfectly healthy.
 */
async function checkDatabase(): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const base = clientEnv.NEXT_PUBLIC_SUPABASE_URL;

  try {
    const rpc = await fetch(`${base}/rest/v1/rpc/health_check`, {
      method: 'POST',
      headers: { ...REST_HEADERS, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });

    if (rpc.ok) return { ok: true, latencyMs: elapsed(), probe: 'rpc' };

    if (rpc.status === 401 || rpc.status === 403) {
      return { ok: false, latencyMs: elapsed(), detail: 'API key rejected by PostgREST' };
    }
    if (rpc.status >= 500) {
      return { ok: false, latencyMs: elapsed(), detail: `PostgREST returned ${rpc.status}` };
    }

    // 404 — health_check() not defined yet. Fall back to the sentinel probe.
    const sentinel = await fetch(`${base}/rest/v1/__health__?select=*&limit=1`, {
      headers: REST_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });

    if (sentinel.status === 401 || sentinel.status === 403) {
      return { ok: false, latencyMs: elapsed(), detail: 'API key rejected by PostgREST' };
    }
    if (sentinel.status >= 500) {
      return { ok: false, latencyMs: elapsed(), detail: `PostgREST returned ${sentinel.status}` };
    }

    return {
      ok: true,
      latencyMs: elapsed(),
      probe: 'schema-cache',
      detail: 'PostgREST reachable; add public.health_check() for a true database probe',
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: elapsed(),
      detail: error instanceof Error ? error.message : 'unreachable',
    };
  }
}

async function checkAuth(): Promise<CheckResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${clientEnv.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: REST_HEADERS.apikey },
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
