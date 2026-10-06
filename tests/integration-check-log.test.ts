import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runIntegrationCheck, type CheckClass, type CheckLogEntry, type HttpClient } from '../src/modules/projects/integration-check.ts';
import { integrationCheckLogWriter } from '../src/modules/projects/integration-check-log.ts';

/**
 * A check logs what it measured: the HTTP status the provider answered and how long the call took, read from an injected clock so the numbers are
 * deterministic here. The measurement goes through the optional `log` callback; without it the original `note` path is unchanged
 * (tests/integration-check.test.ts).
 */
const conn = (over: Partial<{ checkUrl: string | null; credentialRef: string | null; isMock: boolean }> = {}) => ({
  id: 'c1', kind: 'payment', health: 'configured', isMock: false, checkUrl: 'https://api.example.test/health', credentialRef: null, ...over,
});

/** A clock that advances by the scripted step each time it is read: a read returns the current time and then advances it by the next step, so the step consumed at an attempt's start read IS that attempt's latency (every attempt reads twice: start, end). */
function clock(steps: number[]) {
  let t = Date.parse('2026-10-06T12:00:00Z');
  let i = 0;
  return () => {
    const date = new Date(t);
    t += steps[Math.min(i, steps.length - 1)] ?? 0;
    i += 1;
    return date;
  };
}

function run(script: (Awaited<ReturnType<HttpClient>> | Error)[], steps: number[], withLog = true, connection = conn()) {
  const logs: CheckLogEntry[] = [];
  const notes: CheckClass[] = [];
  let i = 0;
  const http: HttpClient = async () => {
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next!;
  };
  const outcome = runIntegrationCheck({
    connection, adapter: 'http_health', http, env: {}, maxAttempts: 3, sleep: async () => {},
    now: clock(steps),
    record: async (a) => (a.ok ? 'verified' : 'degraded'),
    note: async (c) => { notes.push(c); },
    ...(withLog ? { log: async (e: CheckLogEntry) => { logs.push(e); } } : {}),
  });
  return { outcome, logs, notes };
}

describe('a check logs its HTTP status and latency', () => {
  test('a 200 is logged as ok with its status and the measured latency', async () => {
    const r = run([{ status: 200 }], [250, 0, 0, 0]);
    assert.equal((await r.outcome).recorded, 'verified');
    assert.deepEqual(r.logs, [{ checkClass: 'ok', httpStatus: 200, latencyMs: 250 }]);
    assert.deepEqual(r.notes, [], 'the measured log replaces the bare note: one check, one row');
  });

  test('a 401 is logged with its status and latency, never as a pass', async () => {
    const r = run([{ status: 401 }], [90, 0, 0]);
    assert.equal((await r.outcome).recorded, 'degraded');
    assert.deepEqual(r.logs, [{ checkClass: 'unauthorized', httpStatus: 401, latencyMs: 90 }]);
  });

  test('after retries the entry is the LAST attempt\'s own status and latency', async () => {
    // attempt 1: 503 in 40 ms; attempt 2: 503 in 60 ms; attempt 3: 429 in 10 ms
    const r = run([{ status: 503 }, { status: 503 }, { status: 429 }], [40, 0, 60, 0, 10, 0, 0]);
    const out = await r.outcome;
    assert.equal(out.attempts, 3);
    assert.deepEqual(r.logs, [{ checkClass: 'rate_limited', httpStatus: 429, latencyMs: 10 }]);
  });

  test('a call that never got an answer carries no status, and the time it spent', async () => {
    const r = run([Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })], [10_000, 0, 10_000, 0, 10_000, 0, 0], true);
    const out = await r.outcome;
    assert.equal(out.checkClass, 'timeout');
    assert.deepEqual(r.logs, [{ checkClass: 'timeout', httpStatus: null, latencyMs: 10_000 }]);
  });

  test('a check that asked nothing of the provider carries no measurement, never an invented one', async () => {
    const noTarget = run([{ status: 200 }], [0], true, conn({ checkUrl: null }));
    await noTarget.outcome;
    assert.deepEqual(noTarget.logs, [{ checkClass: 'no_target', httpStatus: null, latencyMs: null }]);
    const noSecret = run([{ status: 200 }], [0], true, conn({ credentialRef: 'MISSING_SECRET_NAME' }));
    await noSecret.outcome;
    assert.deepEqual(noSecret.logs, [{ checkClass: 'credential_missing', httpStatus: null, latencyMs: null }]);
  });

  test('a mock logs nothing at all: nothing was asked of a provider', async () => {
    const r = run([{ status: 200 }], [0], true, conn({ isMock: true }));
    await r.outcome;
    assert.deepEqual(r.logs, []);
    assert.deepEqual(r.notes, []);
  });

  test('without a log callback the bare note is used, exactly as before', async () => {
    const r = run([{ status: 404 }], [5, 0, 0], false);
    await r.outcome;
    assert.deepEqual(r.notes, ['not_found']);
    assert.deepEqual(r.logs, []);
  });

  test('a clock that runs backwards never produces a negative latency', async () => {
    const r = run([{ status: 200 }], [-500, 0, 0]);
    await r.outcome;
    assert.equal(r.logs[0]?.latencyMs, 0);
  });
});

describe('the log writer is the service-role door, with the measurement as its arguments', () => {
  function fakeAdmin(data: unknown, error: { message: string } | null = null) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const admin = { schema: (name: string) => ({ name, rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn: `${name}.${fn}`, args }); return { data, error }; } }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { admin: admin as any, calls };
  }

  test('log_integration_check gets the class, the status and the latency', async () => {
    const { admin, calls } = fakeAdmin([{ outcome: 'noted' }]);
    await integrationCheckLogWriter(admin, 'conn-1')({ checkClass: 'ok', httpStatus: 200, latencyMs: 123 });
    assert.deepEqual(calls, [{ fn: 'projects.log_integration_check', args: { p_connection_id: 'conn-1', p_class: 'ok', p_http_status: 200, p_latency_ms: 123 } }]);
  });

  test('a refusal or an error is thrown, so a missing log row is visible', async () => {
    await assert.rejects(integrationCheckLogWriter(fakeAdmin([{ outcome: 'adapter_only' }]).admin, 'c')({ checkClass: 'ok', httpStatus: 200, latencyMs: 1 }), /adapter_only/);
    await assert.rejects(integrationCheckLogWriter(fakeAdmin(null, { message: 'down' }).admin, 'c')({ checkClass: 'ok', httpStatus: 200, latencyMs: 1 }), /down/);
  });
});
