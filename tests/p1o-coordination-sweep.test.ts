// Phase 1 Coordination: the sweep that withdraws stale handoffs and expires lapsed meeting offers (P1-COORD-018/027, P1-SCHED-026).
// Proved against a stand-in database that records which doors were called, for which organisation, and fails on request.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runCoordinationSweep } from '../src/modules/orchestrator/p1o-coordination-sweep.ts';

type Answer = { data: unknown; error: { message: string } | null };
function fakeAdmin(answers: Record<string, Answer>) {
  const calls: Array<{ schema: string; fn: string; args: Record<string, unknown> }> = [];
  const admin = {
    schema: (schema: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ schema, fn, args });
        return Promise.resolve(answers[fn] ?? { data: null, error: { message: `unexpected call ${fn}` } });
      },
    }),
  };
  return { admin: admin as never, calls };
}
const ORG = '00000000-0000-4000-8000-0000000000aa';

describe('the coordination sweep', () => {
  test("it calls both runner doors for the job's own organisation and nothing else", async () => {
    const f = fakeAdmin({
      p1o_invalidate_stale_handoffs: { data: [{ withdrawn: 2, blocked: 1 }], error: null },
      p1o_expire_stale_proposals: { data: [{ expired: 3 }], error: null },
    });
    const r = await runCoordinationSweep(f.admin, { organization_id: ORG });
    assert.deepEqual(f.calls.map((c) => `${c.schema}.${c.fn}`), ['ai.p1o_invalidate_stale_handoffs', 'crm.p1o_expire_stale_proposals']);
    assert.ok(f.calls.every((c) => c.args.p_organization_id === ORG && Object.keys(c.args).length === 1));
    assert.equal(r.status, 'succeeded');
    if (r.status === 'succeeded') {
      assert.equal(r.outcome, 'swept');
      assert.match(r.detail, /2 handoff\(s\) withdrawn, 1 marked blocked, 3 meeting offer\(s\) expired/);
    }
  });

  test('a quiet organisation is a settled success, not a failure', async () => {
    const f = fakeAdmin({
      p1o_invalidate_stale_handoffs: { data: [{ withdrawn: 0, blocked: 0 }], error: null },
      p1o_expire_stale_proposals: { data: [{ expired: 0 }], error: null },
    });
    const r = await runCoordinationSweep(f.admin, { organization_id: ORG });
    assert.ok(r.status === 'succeeded' && r.outcome === 'nothing_to_sweep');
  });

  test('a failed read of the handoffs is a retryable failure, never "nothing to sweep", and the second door is not reached', async () => {
    const f = fakeAdmin({ p1o_invalidate_stale_handoffs: { data: null, error: { message: 'connection reset' } } });
    const r = await runCoordinationSweep(f.admin, { organization_id: ORG });
    assert.ok(r.status === 'failed' && r.permanent === false && /connection reset/.test(r.detail));
    assert.equal(f.calls.length, 1);
  });

  test('a failure of the second door is also retryable', async () => {
    const f = fakeAdmin({
      p1o_invalidate_stale_handoffs: { data: [{ withdrawn: 1, blocked: 0 }], error: null },
      p1o_expire_stale_proposals: { data: null, error: { message: 'timeout' } },
    });
    const r = await runCoordinationSweep(f.admin, { organization_id: ORG });
    assert.ok(r.status === 'failed' && r.permanent === false);
  });

  test('running it twice is safe: the second run finds nothing left', async () => {
    let first = true;
    const admin = {
      schema: () => ({
        rpc: (fn: string) => {
          const swept = first;
          if (fn === 'p1o_expire_stale_proposals') first = false;
          return Promise.resolve({ data: fn === 'p1o_invalidate_stale_handoffs' ? [{ withdrawn: swept ? 1 : 0, blocked: 0 }] : [{ expired: swept ? 1 : 0 }], error: null });
        },
      }),
    } as never;
    const a = await runCoordinationSweep(admin, { organization_id: ORG });
    const b = await runCoordinationSweep(admin, { organization_id: ORG });
    assert.ok(a.status === 'succeeded' && a.outcome === 'swept');
    assert.ok(b.status === 'succeeded' && b.outcome === 'nothing_to_sweep');
  });
});
