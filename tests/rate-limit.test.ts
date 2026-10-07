// P1-DOD-064: the public routes are rate limited through the database counter, fail OPEN when it is unreachable, and the four public routes use it
// before they read a body. The counter itself is proved against a real Postgres in scripts/verify-rate-limit.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { clientKeyFrom, hitRateLimit, limitPublicRoute, tooManyRequests } from '../src/lib/security/rate-limit.ts';

function adminAnswering(answer: () => { data: unknown; error: { message: string } | null } | Promise<never>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    schema: (name: string) => {
      assert.equal(name, 'core');
      return {
        rpc: (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return Promise.resolve().then(answer);
        },
      };
    },
  };
  return { admin: admin as never, calls };
}

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

test('the caller key is the first forwarded address, then the real ip, then one shared key', () => {
  assert.equal(clientKeyFrom(headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(clientKeyFrom(headers({ 'x-real-ip': '198.51.100.2' })), '198.51.100.2');
  assert.equal(clientKeyFrom(headers({})), 'unknown');
});

test('an allowed hit passes and a refused hit becomes a 429 with Retry-After', async () => {
  const ok = adminAnswering(() => ({ data: [{ allowed: true, remaining: 4, retry_after_seconds: 30 }], error: null }));
  assert.equal(await limitPublicRoute({ headers: headers({ 'x-forwarded-for': '203.0.113.7' }) }, ok.admin, 'webhook-test', 5, 60), null);
  assert.deepEqual(ok.calls[0], { fn: 'rate_limit_hit', args: { p_bucket: 'webhook-test', p_key: '203.0.113.7', p_limit: 5, p_window_seconds: 60 } });

  const no = adminAnswering(() => ({ data: [{ allowed: false, remaining: 0, retry_after_seconds: 41 }], error: null }));
  const res = await limitPublicRoute({ headers: headers({}) }, no.admin, 'webhook-test', 5, 60);
  assert.ok(res);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '41');
});

test('FAIL OPEN: a database error, an empty answer and a thrown error all let the request through, marked degraded', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const input = { bucket: 'b', key: 'k', limit: 1, windowSeconds: 60 };
    assert.deepEqual(await hitRateLimit(adminAnswering(() => ({ data: null, error: { message: 'down' } })).admin, input), { allowed: true, retryAfterSeconds: 0, degraded: true });
    assert.equal((await hitRateLimit(adminAnswering(() => ({ data: [], error: null })).admin, input)).degraded, true);
    assert.equal((await hitRateLimit(adminAnswering(() => Promise.reject(new Error('network'))).admin, input)).allowed, true);
  } finally {
    console.error = quiet;
  }
});

test('the 429 reveals neither the limit nor the key', async () => {
  const res = tooManyRequests(0);
  assert.equal(res.headers.get('retry-after'), '1', 'never 0 or negative');
  assert.deepEqual(await res.json(), { ok: false, error: 'too many requests' });
});

test('every public route asks the limiter before it reads anything', () => {
  const routes: [string, RegExp][] = [
    ['app/api/webhooks/whatsapp/route.ts', /limitPublicRoute\(request, createAdminClient\(\), 'webhook-whatsapp'[\s\S]*?readBoundedBody/],
    ['app/api/webhooks/email/route.ts', /limitPublicRoute\(request, createAdminClient\(\), 'webhook-email'[\s\S]*?content-length/],
    ['app/api/webhooks/facebook-leads/route.ts', /limitPublicRoute\(request, createAdminClient\(\), 'webhook-facebook-leads'[\s\S]*?readBoundedBody/],
    ['app/api/outreach/unsubscribe/[token]/route.ts', /limitPublicRoute\(_request, createAdminClient\(\), 'unsubscribe'[\s\S]*?await params/],
  ];
  for (const [file, pattern] of routes) {
    assert.match(readFileSync(file, 'utf8'), pattern, `${file} limits before it reads`);
  }
});
