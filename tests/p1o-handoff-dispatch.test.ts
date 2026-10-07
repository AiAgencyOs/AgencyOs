// dispatchTask: the sanctioned way to hand a task over. An invalid envelope is refused before anything runs, an unroutable task type is not created, and a
// duplicate returns the task it already made. The database half (idempotency, prerequisites, cycles) is scripts/verify-p1o-handoffs.sql.
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let answer: { data: unknown; error: { message: string } | null } = { data: [{ outcome: 'created', handoff_id: 'h-1' }], error: null };

mock.module('@/lib/db/p1o-rpc', {
  exports: {
    adminRpc: () => (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve(answer);
    },
    asRows: (v: unknown) => (Array.isArray(v) ? v : []),
    firstRow: (v: unknown) => (Array.isArray(v) ? (v[0] ?? null) : null),
    text: (v: unknown) => (typeof v === 'string' ? v : null),
  },
});
mock.module('@/lib/db/admin', { exports: { createAdminClient: () => ({}) } });

const { dispatchTask } = await import('../src/modules/orchestrator/p1o-handoff-create.ts');

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const good = { organizationId: ID(1), taskType: 'workflow.tracking', correlationId: ID(2), idempotencyKey: 'k:1', fromAgent: 'sales', toAgent: 'quality_assurance', objective: 'check', acceptanceCriteria: ['done'] };
const routed = async () => ({ routed: true as const, handlerKind: 'service' as const, handlerKey: 'ai.handoffs' });

describe('dispatchTask', () => {
  test('an invalid envelope is refused and the database is not touched', async () => {
    calls.length = 0;
    const r = await dispatchTask({ ...good, acceptanceCriteria: [] }, { route: routed });
    assert.equal(r.state, 'invalid');
    assert.equal(calls.length, 0);
  });

  test('an unroutable task type is not created: the caller escalates to a person', async () => {
    calls.length = 0;
    const r = await dispatchTask(good, { route: async () => ({ routed: false as const, reason: 'no registered capability for this task type' }) });
    assert.deepEqual(r, { state: 'no_route', reason: 'no registered capability for this task type' });
    assert.equal(calls.length, 0);
  });

  test('a good envelope reaches the creation door with the whole contract', async () => {
    calls.length = 0;
    answer = { data: [{ outcome: 'created', handoff_id: 'h-1' }], error: null };
    const r = await dispatchTask({ ...good, priority: 'urgent', dependencyIds: [ID(9)] }, { route: routed });
    assert.deepEqual(r, { state: 'created', handoffId: 'h-1' });
    assert.equal(calls[0]?.fn, 'p1o_create_handoff');
    assert.equal(calls[0]?.args.p_priority, 'urgent');
    assert.deepEqual(calls[0]?.args.p_dependency_ids, [ID(9)]);
    assert.equal(calls[0]?.args.p_idempotency_key, 'k:1');
  });

  test('the same key again returns the task already made', async () => {
    answer = { data: [{ outcome: 'duplicate', handoff_id: 'h-1' }], error: null };
    assert.deepEqual(await dispatchTask(good, { route: routed }), { state: 'duplicate', handoffId: 'h-1' });
  });

  test('a refusal word from the door is surfaced, not swallowed', async () => {
    answer = { data: [{ outcome: 'refused', handoff_id: null }], error: null };
    assert.deepEqual(await dispatchTask(good, { route: routed }), { state: 'refused', outcome: 'refused' });
  });

  test('a database error throws: it is never read as "created" or "nothing to do"', async () => {
    answer = { data: null, error: { message: 'down' } };
    await assert.rejects(() => dispatchTask(good, { route: routed }), /down/);
  });
});
