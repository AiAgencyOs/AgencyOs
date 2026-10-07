import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { backoffMs, classifyStatus, INTEGRATION_SECRET_NAME, isRetryable, isSafeCheckUrl, runIntegrationCheck, type CheckClass, type HttpClient } from '../src/modules/projects/integration-check.ts';

/**
 * The adapter's DECISIONS are proven here against a scripted fake provider (200, 401, 404, 429, 5xx, timeout, network). The REAL provider is the
 * one thing this cannot prove: that needs the provider's sandbox credentials, which only the owner has.
 */
const conn = (over: Partial<{ checkUrl: string | null; credentialRef: string | null; isMock: boolean }> = {}) => ({
  id: 'c1', kind: 'payment', health: 'configured', isMock: false, checkUrl: 'https://api.example.test/health', credentialRef: 'INTEGRATION_PROVIDER_TEST_KEY', ...over,
});

function harness(script: (Awaited<ReturnType<HttpClient>> | Error)[], env: Record<string, string> = { INTEGRATION_PROVIDER_TEST_KEY: 'sk-test-SECRET-VALUE-123456' }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const sleeps: number[] = [];
  const recorded: { ok: boolean; evidence: string }[] = [];
  const notes: CheckClass[] = [];
  let i = 0;
  const http: HttpClient = async (req) => {
    calls.push({ url: req.url, headers: req.headers });
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next!;
  };
  const run = (connection = conn(), maxAttempts = 3) =>
    runIntegrationCheck({
      connection, adapter: 'http_health', http, env, maxAttempts,
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => new Date('2026-10-06T12:00:00Z'),
      record: async (a) => { recorded.push(a); return a.ok ? 'verified' : 'degraded'; },
      note: async (c) => { notes.push(c); },
    });
  return { run, calls, sleeps, recorded, notes };
}

describe('classification and retry policy', () => {
  test('statuses map to classes; only throttles, server errors, timeouts and dropped connections retry', () => {
    assert.equal(classifyStatus(200), 'ok');
    assert.equal(classifyStatus(204), 'ok');
    assert.equal(classifyStatus(401), 'unauthorized');
    assert.equal(classifyStatus(403), 'unauthorized');
    assert.equal(classifyStatus(404), 'not_found');
    assert.equal(classifyStatus(429), 'rate_limited');
    assert.equal(classifyStatus(503), 'server_error');
    for (const c of ['rate_limited', 'server_error', 'timeout', 'network'] as const) assert.equal(isRetryable(c), true, c);
    for (const c of ['unauthorized', 'not_found', 'credential_missing', 'no_target', 'ok'] as const) assert.equal(isRetryable(c), false, c);
  });
  test('backoff grows, is capped, is deterministic, and honours Retry-After', () => {
    assert.ok(backoffMs(2, null, 1) > backoffMs(1, null, 1) - 250);
    assert.ok(backoffMs(10, null, 3) <= 8250);
    assert.equal(backoffMs(2, null, 5), backoffMs(2, null, 5));
    assert.equal(backoffMs(1, 7), 7000);
    assert.equal(backoffMs(1, 600), 60000);
  });
});

describe('runIntegrationCheck', () => {
  test('a 200 verifies, with evidence that names the host, the status and the time - and never the secret', async () => {
    const h = harness([{ status: 200 }]);
    const out = await h.run();
    assert.equal(out.recorded, 'verified');
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0]!.ok, true);
    assert.match(h.recorded[0]!.evidence, /HTTP 200 from api\.example\.test at 2026-10-06T12:00:00\.000Z/);
    assert.ok(!JSON.stringify(h.recorded).includes('SECRET-VALUE'), 'the secret is never in evidence');
    assert.equal(h.calls[0]!.headers.authorization, 'Bearer sk-test-SECRET-VALUE-123456');
    assert.deepEqual(h.notes, ['ok']);
  });
  test('a mock is never verified and nothing is called', async () => {
    const h = harness([{ status: 200 }]);
    const out = await h.run(conn({ isMock: true }));
    assert.equal(out.recorded, 'nothing');
    assert.equal(h.calls.length, 0);
    assert.equal(h.recorded.length, 0);
  });
  test('no check URL: nothing is checked, nothing verified', async () => {
    const h = harness([{ status: 200 }]);
    const out = await h.run(conn({ checkUrl: null }));
    assert.equal(out.checkClass, 'no_target');
    assert.equal(h.calls.length, 0);
    assert.equal(h.recorded.length, 0);
  });
  test('a missing secret verifies nothing, calls nothing and says which name is unset', async () => {
    const h = harness([{ status: 200 }], {});
    const out = await h.run();
    assert.equal(out.checkClass, 'credential_missing');
    assert.equal(out.recorded, 'nothing');
    assert.match(out.detail, /INTEGRATION_PROVIDER_TEST_KEY/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.recorded.length, 0);
  });
  test('401 degrades at once and is never retried', async () => {
    const h = harness([{ status: 401 }]);
    const out = await h.run();
    assert.equal(out.recorded, 'degraded');
    assert.equal(out.checkClass, 'unauthorized');
    assert.equal(h.calls.length, 1);
    assert.equal(h.recorded[0]!.ok, false);
  });
  test('429 honours Retry-After, then verifies on the next answer', async () => {
    const h = harness([{ status: 429, retryAfterSeconds: 2 }, { status: 200 }]);
    const out = await h.run();
    assert.equal(out.recorded, 'verified');
    assert.equal(out.attempts, 2);
    assert.deepEqual(h.sleeps, [2000]);
  });
  test('persistent 5xx exhausts the budget and degrades, with bounded attempts', async () => {
    const h = harness([{ status: 503 }]);
    const out = await h.run();
    assert.equal(out.recorded, 'degraded');
    assert.equal(out.attempts, 3);
    assert.equal(h.calls.length, 3);
    assert.equal(h.sleeps.length, 2);
  });
  test('a timeout and a dropped connection are retried and classified', async () => {
    const t = harness([Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]);
    assert.equal((await t.run()).checkClass, 'timeout');
    const n = harness([new Error('fetch failed')]);
    assert.equal((await n.run()).checkClass, 'network');
    assert.equal(n.calls.length, 3);
  });
  test('the door refusing the write is reported, not claimed as verified', async () => {
    const h = harness([{ status: 200 }]);
    const out = await runIntegrationCheck({
      connection: conn(), adapter: 'http_health', http: async () => ({ status: 200 }), env: { INTEGRATION_PROVIDER_TEST_KEY: 'x' }, sleep: async () => {}, now: () => new Date(),
      record: async () => 'mock_cannot_verify', note: async () => {},
    });
    assert.equal(out.recorded, 'nothing');
    assert.match(out.detail, /mock_cannot_verify/);
    void h;
  });
});


describe('a check cannot be aimed at the server\'s own secrets or network', () => {
  test('only INTEGRATION_ secrets may authenticate a check', async () => {
    assert.ok(INTEGRATION_SECRET_NAME.test('INTEGRATION_STRIPE_TEST'));
    for (const bad of ['SUPABASE_SERVICE_ROLE_KEY', 'BUILD_REPORT_SECRET', 'CRON_SECRET', 'GITHUB_TOKEN', 'integration_x', 'INTEGRATION_']) assert.equal(INTEGRATION_SECRET_NAME.test(bad), false, bad);
    const h = harness([{ status: 200 }], { SUPABASE_SERVICE_ROLE_KEY: 'service-key-value-0123456789' });
    const out = await h.run(conn({ credentialRef: 'SUPABASE_SERVICE_ROLE_KEY' }));
    assert.equal(out.recorded, 'nothing');
    assert.equal(h.calls.length, 0, 'nothing was sent anywhere');
    assert.equal(h.recorded.length, 0);
  });
  test('unsafe URLs are refused and nothing is called', async () => {
    for (const url of ['http://api.example.test/h', 'https://localhost/h', 'https://127.0.0.1/h', 'https://10.0.0.5/h', 'https://192.168.1.2/h', 'https://172.20.1.1/h', 'https://169.254.169.254/latest', 'https://[::1]/h', 'https://user:pw@api.example.test/h', 'https://intranet/h', 'https://db.internal/h', 'https://printer.local/h']) {
      assert.equal(isSafeCheckUrl(url), false, url);
      const h = harness([{ status: 200 }]);
      const out = await h.run(conn({ checkUrl: url }));
      assert.equal(out.checkClass, 'no_target', url);
      assert.equal(h.calls.length, 0, url);
    }
    for (const url of ['https://api.example.test/health', 'https://api.stripe.com/v1/ping', 'https://8.8.8.8/x']) assert.equal(isSafeCheckUrl(url), true, url);
  });
});
