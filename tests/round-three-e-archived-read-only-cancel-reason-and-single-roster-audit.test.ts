import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { projectRoleDbProblem } from '../src/modules/projects/project-role-guard.ts';
import {
  ARCHIVED_READ_ONLY_MESSAGE,
  CANCEL_REASON_MESSAGE,
  archivedTaskProblem,
  cancelOrArchiveDbProblem,
  cancelReasonProblem,
} from '../src/modules/projects/task-transitions.ts';

/**
 * Owner decisions U1-1 (an archived task is read-only), U1-2 (a cancel says why)
 * and U1-3 (a roster change through a door is audited once). The database half is
 * proven by scripts/verify-v1-*.mjs; this is the words the service answers with
 * and the guards it puts in front of the database.
 */

describe('U1-1 an archived task is read-only', () => {
  test('says so for either shape of a task row, and only when archived', () => {
    assert.equal(archivedTaskProblem({ archivedAt: '2026-10-01T00:00:00Z' }), ARCHIVED_READ_ONLY_MESSAGE);
    assert.equal(archivedTaskProblem({ archived_at: '2026-10-01T00:00:00Z' }), ARCHIVED_READ_ONLY_MESSAGE);
    assert.equal(archivedTaskProblem({ archivedAt: null }), null);
    assert.equal(archivedTaskProblem({ archived_at: null }), null);
    assert.equal(archivedTaskProblem(null), null);
  });

  test('the database refusal reads as the same plain sentence wherever it is mapped', () => {
    const raw = 'task_archived_read_only: an archived task is read-only; restore it first';
    assert.equal(cancelOrArchiveDbProblem(raw), ARCHIVED_READ_ONLY_MESSAGE);
    assert.equal(projectRoleDbProblem(raw), ARCHIVED_READ_ONLY_MESSAGE);
    assert.equal(projectRoleDbProblem('task_archived_read_only'), ARCHIVED_READ_ONLY_MESSAGE);
    assert.equal(projectRoleDbProblem('something else'), null);
  });

  test('the sentence tells who can restore it', () => {
    assert.match(ARCHIVED_READ_ONLY_MESSAGE, /restore/i);
    assert.match(ARCHIVED_READ_ONLY_MESSAGE, /delivery lead/);
  });
});

describe('U1-2 a cancel needs a reason', () => {
  test('asks for one on a move to cancelled, and only then', () => {
    assert.equal(cancelReasonProblem('todo', 'cancelled', undefined), CANCEL_REASON_MESSAGE);
    assert.equal(cancelReasonProblem('in_progress', 'cancelled', '   '), CANCEL_REASON_MESSAGE);
    assert.equal(cancelReasonProblem('blocked', 'cancelled', null), CANCEL_REASON_MESSAGE);
    assert.equal(cancelReasonProblem('todo', 'cancelled', 'Client dropped it'), null);
    assert.equal(cancelReasonProblem('todo', 'in_progress', undefined), null);
    assert.equal(cancelReasonProblem('cancelled', 'cancelled', undefined), null);
    assert.equal(cancelReasonProblem('cancelled', 'todo', undefined), null);
  });

  test('the database refusal maps to the same sentence', () => {
    assert.equal(cancelOrArchiveDbProblem('task_cancel_requires_reason: say why the task is cancelled'), CANCEL_REASON_MESSAGE);
  });
});

describe('the service guards in front of the database', () => {
  const writes: unknown[] = [];
  const lastWrite = () => (writes[writes.length - 1] ?? {}) as Record<string, unknown>;
  let task: Record<string, unknown> | null = null;
  const query = (table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === 'tasks' ? task : null, error: null }),
      update: (values: unknown) => {
        writes.push(values);
        return { eq: async () => ({ error: null, count: 1 }) };
      },
    };
    return q;
  };
  const client = { schema: () => ({ from: query, rpc: async () => ({ data: [{ outcome: 'set' }], error: null }) }) };
  mock.module('@/lib/db/server', { exports: { createClient: async () => client } });
  mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ userId: 'u0', organizationId: 'o1' }) } });
  mock.module('@/lib/authz/permissions', { exports: { can: () => true } });

  const TASK = '11111111-1111-4111-8111-111111111111';

  test('a comment, time log, checklist or dependency change on an archived task is refused even for a roster manager', async () => {
    const { taskRoleRefusal } = await import('../src/modules/projects/project-role-service.ts');
    task = { project_id: 'p1', assignee_id: null, archived_at: '2026-10-01T00:00:00Z' };
    const refusal = await taskRoleRefusal({ userId: 'u0', organizationId: 'o1' } as never, TASK);
    assert.ok(refusal && !refusal.ok);
    assert.equal(refusal.error.message, ARCHIVED_READ_ONLY_MESSAGE);
    assert.equal(refusal.error.code, 'CONFLICT');
  });

  test('a live task is not refused', async () => {
    const { taskRoleRefusal } = await import('../src/modules/projects/project-role-service.ts');
    task = { project_id: 'p1', assignee_id: null, archived_at: null };
    assert.equal(await taskRoleRefusal({ userId: 'u0', organizationId: 'o1' } as never, TASK), null);
  });

  test('a status change on an archived task writes nothing', async () => {
    const { setTaskStatus } = await import('../src/modules/projects/service.ts');
    task = { status: 'todo', project_id: 'p1', assignee_id: null, archived_at: '2026-10-01T00:00:00Z' };
    writes.length = 0;
    const result = await setTaskStatus({ taskId: TASK, status: 'in_progress' });
    assert.ok(!result.ok && result.error.message === ARCHIVED_READ_ONLY_MESSAGE);
    assert.deepEqual(writes, []);
  });

  test('a cancel without a reason writes nothing; with one it carries cancel_reason', async () => {
    const { setTaskStatus } = await import('../src/modules/projects/service.ts');
    task = { status: 'todo', project_id: 'p1', assignee_id: 'u0', archived_at: null };
    writes.length = 0;
    const bare = await setTaskStatus({ taskId: TASK, status: 'cancelled' });
    assert.ok(!bare.ok && bare.error.code === 'VALIDATION' && bare.error.message === CANCEL_REASON_MESSAGE);
    assert.deepEqual(writes, []);
    const done = await setTaskStatus({ taskId: TASK, status: 'cancelled', reason: 'Client dropped the feature' });
    assert.equal(done.ok, true);
    assert.equal(lastWrite().cancel_reason, 'Client dropped the feature');
    assert.equal(lastWrite().status, 'cancelled');
  });

  test('a move that is not a cancel does not send a cancel reason', async () => {
    const { setTaskStatus } = await import('../src/modules/projects/service.ts');
    task = { status: 'todo', project_id: 'p1', assignee_id: 'u0', archived_at: null };
    writes.length = 0;
    await setTaskStatus({ taskId: TASK, status: 'in_progress' });
    assert.ok(!('cancel_reason' in lastWrite()));
  });
});
