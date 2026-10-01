import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { ARCHIVED_READ_ONLY_MESSAGE } from '../src/modules/projects/task-transitions.ts';

/** V1-1: a subtask is not added under an archived task. The database half is proven by scripts/verify-v1-*.mjs. */
describe('V1-1 addSubtask under an archived task', () => {
  let parent: Record<string, unknown> | null = null;
  let rpcResult: { data: unknown; error: { message: string } | null } = { data: [{ outcome: 'added', task_id: 't2' }], error: null };
  const calls: string[] = [];
  const query = () => {
    const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: parent, error: null }) };
    return q;
  };
  const client = { schema: () => ({ from: query, rpc: async (name: string) => (calls.push(name), rpcResult) }) };
  mock.module('@/lib/db/server', { exports: { createClient: async () => client } });
  mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ userId: 'u0', organizationId: 'o1' }) } });
  mock.module('@/lib/authz/permissions', { exports: { can: () => true } });
  const input = { projectId: '22222222-2222-4222-8222-222222222222', parentTaskId: '11111111-1111-4111-8111-111111111111', title: 'Step' };

  test('is refused with the plain sentence before the database is asked', async () => {
    const { addSubtask } = await import('../src/modules/projects/task-plan-service.ts');
    parent = { archived_at: '2026-10-01T00:00:00Z' };
    calls.length = 0;
    const r = await addSubtask(input as never);
    assert.ok(!r.ok);
    assert.equal(r.error.message, ARCHIVED_READ_ONLY_MESSAGE);
    assert.equal(r.error.code, 'CONFLICT');
    assert.deepEqual(calls, []);
  });

  test('the door outcome and the trigger error read the same way', async () => {
    const { addSubtask } = await import('../src/modules/projects/task-plan-service.ts');
    parent = { archived_at: null };
    rpcResult = { data: [{ outcome: 'task_archived_read_only', task_id: null }], error: null };
    let r = await addSubtask(input as never);
    assert.ok(!r.ok);
    assert.equal(r.error.message, ARCHIVED_READ_ONLY_MESSAGE);
    rpcResult = { data: null, error: { message: 'task_archived_read_only: an archived task is read-only' } };
    r = await addSubtask(input as never);
    assert.ok(!r.ok);
    assert.equal(r.error.message, ARCHIVED_READ_ONLY_MESSAGE);
  });

  test('a live parent takes the subtask', async () => {
    const { addSubtask } = await import('../src/modules/projects/task-plan-service.ts');
    parent = { archived_at: null };
    rpcResult = { data: [{ outcome: 'added', task_id: 't2' }], error: null };
    const r = await addSubtask(input as never);
    assert.ok(r.ok, JSON.stringify(r));
  });
});
