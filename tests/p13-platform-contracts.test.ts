// P1-API-022 / P1-MP3-038 / P1-DOD-061 / P1-API-018 / P1-API-021: the canonical error model, the webhook ledger client and the circuit breaker client.
// The SQL doors themselves are proved against a real Postgres in scripts/verify-p13-webhook-ledger-and-circuit.sql; this file proves the TypeScript side
// and pins the one rule that lives in both languages (which errors count toward a circuit).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  APP_CODE_FOR,
  CANONICAL_ERROR_CODES,
  classifyFailure,
  countsTowardCircuit,
  isCanonicalErrorCode,
  isRetryable,
  retryAfterSeconds,
} from '../src/lib/p13/canonical-errors.ts';
import { admitCall, recordCall, withCircuit } from '../src/lib/p13/circuit-breaker.ts';
import { finishWebhookDelivery, httpStatusForOutcome, recordWebhookDelivery, sha256Hex } from '../src/lib/p13/webhook-ledger.ts';

const MIGRATION = readFileSync(new URL('../supabase/migrations/20261128000000_p13_a_webhook_has_a_ledger_and_a_provider_has_a_circuit_breaker.sql', import.meta.url), 'utf8');

function adminAnswering(answer: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    schema: (name: string) => {
      assert.equal(name, 'core');
      return {
        rpc: (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return Promise.resolve().then(() => answer(fn, args));
        },
      };
    },
  };
  return { admin: admin as never, calls };
}

test('there are twelve canonical codes, each maps to an application code, and a stranger is not canonical', () => {
  assert.equal(CANONICAL_ERROR_CODES.length, 12);
  assert.equal(new Set(CANONICAL_ERROR_CODES).size, 12);
  for (const code of CANONICAL_ERROR_CODES) assert.ok(APP_CODE_FOR[code], code);
  assert.ok(isCanonicalErrorCode('TIMEOUT'));
  assert.ok(!isCanonicalErrorCode('timeout'));
  assert.ok(!isCanonicalErrorCode('BOOM'));
});

test('a failure is classified from evidence, never from message text', () => {
  assert.equal(classifyFailure({ status: 401 }), 'AUTHENTICATION_ERROR');
  assert.equal(classifyFailure({ status: 403 }), 'AUTHORIZATION_ERROR');
  assert.equal(classifyFailure({ status: 404 }), 'NOT_FOUND');
  assert.equal(classifyFailure({ status: 409 }), 'CONFLICT_DUPLICATE');
  assert.equal(classifyFailure({ status: 422 }), 'VALIDATION_ERROR');
  assert.equal(classifyFailure({ status: 429 }), 'RATE_LIMITED');
  assert.equal(classifyFailure({ status: 503 }), 'PROVIDER_UNAVAILABLE');
  assert.equal(classifyFailure({ status: 500 }), 'PROVIDER_ERROR');
  assert.equal(classifyFailure({ status: 504 }), 'TIMEOUT');
  assert.equal(classifyFailure({ aborted: true }), 'TIMEOUT');
  assert.equal(classifyFailure({ kind: 'network' }), 'NETWORK_ERROR');
  assert.equal(classifyFailure({ kind: 'auth', status: 500 }), 'AUTHENTICATION_ERROR', 'the adapter that knows the cause outranks the status');
  assert.equal(classifyFailure({ policyBlocked: true, status: 200 }), 'POLICY_BLOCKED');
  assert.equal(classifyFailure({ invalidShape: true }), 'VALIDATION_ERROR');
  assert.equal(classifyFailure({}), 'UNKNOWN_ERROR', 'no evidence is an unknown failure, not a guess');
  assert.equal(classifyFailure({ status: 200 }), 'UNKNOWN_ERROR');
});

test('permanent errors and bad credentials are not retried; transient ones may be; unknown is not retried blindly', () => {
  for (const c of ['AUTHENTICATION_ERROR', 'AUTHORIZATION_ERROR', 'VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT_DUPLICATE', 'POLICY_BLOCKED', 'UNKNOWN_ERROR'] as const) assert.equal(isRetryable(c), false, c);
  for (const c of ['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR', 'NETWORK_ERROR'] as const) assert.equal(isRetryable(c), true, c);
});

test('the TypeScript and SQL lists of caller-fault errors are the same list', () => {
  const sql = /not in \(([^)]*)\)/.exec(MIGRATION.slice(MIGRATION.indexOf('function core.p13_error_counts_toward_circuit'), MIGRATION.indexOf('function core.p13_circuit_admit')));
  assert.ok(sql, 'the SQL rule was not found');
  const inSql = [...(sql[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  const inTs = CANONICAL_ERROR_CODES.filter((c) => !countsTowardCircuit(c)).sort();
  assert.deepEqual(inSql, inTs);
  assert.ok(inTs.length === 5);
});

test('Retry-After is honoured as seconds or as a date, clamped, and a missing or junk header falls back', () => {
  const now = new Date('2026-11-28T10:00:00Z');
  assert.equal(retryAfterSeconds('30', now, 5), 30);
  assert.equal(retryAfterSeconds('99999', now, 5, 600), 600);
  assert.equal(retryAfterSeconds('Sat, 28 Nov 2026 10:01:00 GMT', now, 5), 60);
  assert.equal(retryAfterSeconds('Sat, 28 Nov 2026 09:00:00 GMT', now, 5), 1, 'a date in the past is one second, never negative');
  assert.equal(retryAfterSeconds(null, now, 7), 7);
  assert.equal(retryAfterSeconds('soon', now, 7), 7);
});

test('the ledger sends a hash and a size, never the body, and maps the answer', async () => {
  const { admin, calls } = adminAnswering(() => ({ data: [{ outcome: 'accepted', event_id: 'e-1', duplicate_of: null }], error: null }));
  const decision = await recordWebhookDelivery(admin, { organizationId: 'org', provider: 'whatsapp', eventKey: 'wamid.1', signatureStatus: 'valid', body: 'hello client' });
  assert.deepEqual(decision, { outcome: 'accepted', eventId: 'e-1', duplicateOf: null });
  const args = calls[0]?.args ?? {};
  assert.equal(args.p_payload_sha256, sha256Hex('hello client'));
  assert.equal(args.p_payload_bytes, 12);
  assert.ok(!JSON.stringify(args).includes('hello client'), 'the body must not travel to the ledger');
  assert.equal(calls[0]?.fn, 'p13_record_webhook_event');
});

test('the ledger is loud: a transport error or an unusable answer throws, so the route can answer 503 and let the provider redeliver', async () => {
  const down = adminAnswering(() => ({ data: null, error: { message: 'connection refused' } }));
  await assert.rejects(recordWebhookDelivery(down.admin, { organizationId: null, provider: 'email', eventKey: 'k', signatureStatus: 'valid' }), /unreachable/);
  const junk = adminAnswering(() => ({ data: [{ outcome: 'maybe', event_id: 'x' }], error: null }));
  await assert.rejects(recordWebhookDelivery(junk.admin, { organizationId: null, provider: 'email', eventKey: 'k', signatureStatus: 'valid' }), /nothing usable/);
});

test('each ledger outcome has the HTTP answer the contract implies', () => {
  assert.equal(httpStatusForOutcome('accepted'), 200);
  assert.equal(httpStatusForOutcome('duplicate'), 200);
  assert.equal(httpStatusForOutcome('rejected_signature'), 401);
  assert.equal(httpStatusForOutcome('rejected_stale'), 409);
  assert.equal(httpStatusForOutcome('rejected_malformed'), 400);
});

test('finishing a delivery sends the canonical class on failure and nothing on success', async () => {
  const ok = adminAnswering(() => ({ data: 'processed', error: null }));
  assert.equal(await finishWebhookDelivery(ok.admin, 'e-1', { ok: true }), 'processed');
  assert.equal(ok.calls[0]?.args.p_error_class, null);
  const bad = adminAnswering(() => ({ data: 'failed', error: null }));
  assert.equal(await finishWebhookDelivery(bad.admin, 'e-1', { ok: false, errorClass: 'TIMEOUT' }), 'failed');
  assert.equal(bad.calls[0]?.args.p_error_class, 'TIMEOUT');
});

test('an open circuit holds the call back and runs nothing', async () => {
  const { admin } = adminAnswering((fn) => (fn === 'p13_circuit_admit' ? { data: [{ admitted: false, state: 'open', retry_after_seconds: 42 }], error: null } : { data: null, error: null }));
  let ran = false;
  const result = await withCircuit(admin, 'org', 'openrouter', async () => {
    ran = true;
    return { ok: true, value: 1 };
  });
  assert.equal(ran, false);
  assert.deepEqual(result, { ran: false, circuit: 'open', retryAfterSeconds: 42 });
});

test('a call that runs is recorded with its canonical class, and a throw is recorded as UNKNOWN_ERROR and re-thrown', async () => {
  const seen = adminAnswering((fn) => (fn === 'p13_circuit_admit' ? { data: [{ admitted: true, state: 'closed', retry_after_seconds: 0 }], error: null } : { data: 'closed', error: null }));
  const failed = await withCircuit(seen.admin, 'org', 'whatsapp', async () => ({ ok: false as const, errorClass: 'RATE_LIMITED' as const }));
  assert.equal(failed.ran, true);
  const rec = seen.calls.find((c) => c.fn === 'p13_circuit_record');
  assert.deepEqual(rec?.args, { p_organization_id: 'org', p_provider: 'whatsapp', p_ok: false, p_error_class: 'RATE_LIMITED' });

  const thrown = adminAnswering((fn) => (fn === 'p13_circuit_admit' ? { data: [{ admitted: true, state: 'closed', retry_after_seconds: 0 }], error: null } : { data: 'closed', error: null }));
  await assert.rejects(
    withCircuit(thrown.admin, 'org', 'whatsapp', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(thrown.calls.find((c) => c.fn === 'p13_circuit_record')?.args.p_error_class, 'UNKNOWN_ERROR');
});

test('the breaker fails OPEN when it cannot be reached: losing the breaker must not become losing the provider', async () => {
  const down = adminAnswering(() => ({ data: null, error: { message: 'down' } }));
  const quiet = console.error;
  console.error = () => {};
  try {
    const a = await admitCall(down.admin, 'org', 'x-provider');
    assert.equal(a.admitted, true);
    assert.equal(a.degraded, true);
    await recordCall(down.admin, 'org', 'x-provider', { ok: true });
  } finally {
    console.error = quiet;
  }
});

test('the SQL doors are service-role only, the ledger keeps no payload column, and the admin door is audited', () => {
  assert.match(MIGRATION, /grant execute on function core\.p13_record_webhook_event\([^)]*\) to service_role/);
  assert.match(MIGRATION, /revoke all on function core\.p13_circuit_admit\(uuid, text\) from public, anon, authenticated/);
  assert.doesNotMatch(MIGRATION, /payload\s+jsonb/);
  assert.match(MIGRATION, /core\.record_audit\(v_org, 'circuit_breaker\.forced'/);
});
