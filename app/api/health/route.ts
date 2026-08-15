import { createHash } from 'node:crypto';

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
 * How long the scheduler may be silent before it is presumed dead. The same
 * fifteen minutes the job reaper treats as stale — a tick that has not run in
 * that window is not "quiet", it is stopped. Reused rather than re-chosen, so
 * there is one staleness number in the system, not two.
 */
const CRON_STALE_AFTER_SECONDS = 15 * 60;

/**
 * The scheduler's pulse, as an age.
 *
 * A dead cron is the one failure the in-tick alert path cannot report — it
 * runs inside the tick. So the age of the last tick is exposed here, for an
 * external monitor to watch. Reported, not fatal to overall health: the app
 * is still serving requests while the scheduler is down, and conflating the
 * two would make a health check flap for a problem a page should own.
 */
async function checkCron(): Promise<CheckResult & { ageSeconds: number | null }> {
  const started = performance.now();
  try {
    const res = await fetch(`${clientEnv.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/cron_heartbeat_age_seconds`, {
      method: 'POST',
      // The function lives in `core`, not the default `public` schema, so
      // PostgREST needs the profile named or it answers 404.
      headers: { ...REST_HEADERS, 'Content-Type': 'application/json', 'Content-Profile': 'core' },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) return { ok: false, latencyMs, ageSeconds: null, detail: `heartbeat unreadable (${res.status})` };
    const age = Number(await res.json());
    const fresh = Number.isFinite(age) && age <= CRON_STALE_AFTER_SECONDS;
    return {
      ok: fresh,
      latencyMs,
      ageSeconds: Number.isFinite(age) ? Math.round(age) : null,
      detail: fresh ? undefined : `no tick in ${Number.isFinite(age) ? `${Math.round(age)}s` : 'a long time'} — the scheduler may be stopped`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      ageSeconds: null,
      detail: error instanceof Error ? error.message : 'unreachable',
    };
  }
}

/**
 * GET /api/health
 *
 * Liveness + dependency check. Returns 200 when every dependency is reachable,
 * 503 otherwise, so a platform health check can act on it directly. The cron
 * pulse is reported but does NOT gate the 200/503: a stopped scheduler is a
 * page for an external monitor, not a reason to fail a liveness probe the app
 * itself still answers.
 */
export async function GET() {
  const correlationId = newCorrelationId();

  const [database, auth, cron] = await Promise.all([checkDatabase(), checkAuth(), checkCron()]);
  const healthy = database.ok && auth.ok;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checks: { database, auth, cron },
      /**
       * Which database this instance is talking to, as a fingerprint.
       *
       * Gap G-083. `scripts/verify-target.mjs` refuses to run the verification
       * scripts against a database they were not pointed at — but four of them
       * drive the *application*, and nothing checked that the application was
       * pointed at the same place. `next build` inlines
       * NEXT_PUBLIC_SUPABASE_URL, so a build run without the verify
       * environment produces an app aimed wherever `.env.local` points while
       * the scripts write locally. That happened during this audit; the only
       * reason nothing landed in the remote project is that the key did not
       * match the URL.
       *
       * A hash rather than the URL, though the URL is already in the client
       * bundle — NEXT_PUBLIC_ is shipped to browsers — so this adds no new
       * public fact either way. Twelve hex characters is far more than enough
       * to distinguish two deployments and far too few to attack.
       */
      target: createHash('sha256')
        .update(clientEnv.NEXT_PUBLIC_SUPABASE_URL)
        .digest('hex')
        .slice(0, 12),
      correlationId,
      timestamp: new Date().toISOString(),
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
