import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { providerUnavailable } from '../src/lib/ai/failure.ts';
import { callThroughCircuit } from '../src/lib/p13/model-circuit.ts';
import { err, ok } from '../src/lib/result.ts';

type Call = { fn: string; args: Record<string, unknown> };

function breaker(admitted: boolean) {
  const calls: Call[] = [];
  const admin = {
    schema: () => ({
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        if (fn === 'p13_circuit_admit') return Promise.resolve({ data: [{ admitted, state: admitted ? 'closed' : 'open', retry_after_seconds: 30 }], error: null });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  } as never;
  return { admin, calls };
}

describe('W5 circuit breaker on the model call', () => {
  test('a success is returned untouched and recorded as ok', async () => {
    const b = breaker(true);
    const r = await callThroughCircuit(b.admin, 'org', 'openrouter', async () => ok({ n: 1 }));
    assert.deepEqual(r, { ok: true, data: { n: 1 } });
    assert.equal(b.calls.find((c) => c.fn === 'p13_circuit_record')?.args.p_ok, true);
  });

  test('a vendor-unavailable failure is returned as it came and counted against the circuit', async () => {
    const b = breaker(true);
    const failure = providerUnavailable<{ n: number }>('503', 'server');
    const r = await callThroughCircuit(b.admin, 'org', 'openrouter', async () => failure);
    assert.equal(r, failure);
    const rec = b.calls.find((c) => c.fn === 'p13_circuit_record');
    assert.equal(rec?.args.p_ok, false);
    assert.equal(rec?.args.p_error_class, 'PROVIDER_UNAVAILABLE');
  });

  test('a request-level failure (not the vendor) does not count against the circuit', async () => {
    const b = breaker(true);
    const r = await callThroughCircuit(b.admin, 'org', 'openrouter', async () => err('VALIDATION', 'bad json'));
    assert.equal(r.ok, false);
    assert.equal(b.calls.find((c) => c.fn === 'p13_circuit_record')?.args.p_ok, true);
  });

  test('an open circuit never makes the call and answers with the class the router falls back on', async () => {
    const b = breaker(false);
    let called = false;
    const r = await callThroughCircuit(b.admin, 'org', 'openrouter', async () => {
      called = true;
      return ok(1);
    });
    assert.equal(called, false);
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.error.details?.failure, ['unavailable']);
  });

  test('both model call sites in the agent runner go through the breaker', () => {
    const src = readFileSync(new URL('../app/api/jobs/run/agent-run.ts', import.meta.url), 'utf8');
    assert.match(src, /callThroughCircuit\(ctx\.admin, ctx\.job\.organization_id, candidate\.providerId, \(\) => provider\.data\.generateStructured\(request\)\)/);
    assert.match(src, /callThroughCircuit\(ctx\.admin, ctx\.job\.organization_id, candidate\.providerId, \(\) => generateWithTools\(request\)\)/);
    assert.doesNotMatch(src, /await provider\.data\.generateStructured\(/);
  });
});
