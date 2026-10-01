import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { rollup } from '../src/modules/projects/project-view-derive.ts';
import { TASK_STATUSES } from '../src/modules/projects/schema.ts';
import { teamSummary } from '../src/modules/projects/team-summary.ts';
import {
  ARCHIVE_FORBIDDEN_MESSAGE,
  CANCEL_FORBIDDEN_MESSAGE,
  CANCELLED_TERMINAL_MESSAGE,
  CANCEL_FROM_OPEN_MESSAGE,
  cancelOrArchiveDbProblem,
  cancellingProblem,
  isCountedTask,
  isOutstandingTask,
  selectableStatuses,
} from '../src/modules/projects/task-transitions.ts';

/**
 * Owner decision T1-1: a task has a real `cancelled` status and an `archived_at`.
 * A cancelled or archived task is not outstanding work; cancelled is final except
 * a roster manager reopens it. T1-2: the roster is written through audited doors.
 */

describe('T1-1 the cancelled status', () => {
  test('is a status the task form and the filters know', () => {
    assert.ok((TASK_STATUSES as readonly string[]).includes('cancelled'));
  });

  test('can be chosen from an open status and from cancelled itself, never from completed', () => {
    for (const from of ['todo', 'in_progress', 'blocked', 'in_review']) assert.ok(selectableStatuses(TASK_STATUSES, from).includes('cancelled'), from);
    assert.ok(selectableStatuses(TASK_STATUSES, 'cancelled').includes('cancelled'));
    assert.ok(!selectableStatuses(TASK_STATUSES, 'done').includes('cancelled'));
  });

  test('leads out of cancelled only to To do', () => {
    assert.deepEqual(selectableStatuses(TASK_STATUSES, 'cancelled'), ['todo', 'cancelled']);
  });

  test('keeps Q-B1 and the review hand-off: completed only from review, review only where it already is', () => {
    assert.ok(!selectableStatuses(TASK_STATUSES, 'blocked').includes('done'));
    assert.ok(selectableStatuses(TASK_STATUSES, 'in_review').includes('done'));
    assert.ok(!selectableStatuses(TASK_STATUSES, 'todo').includes('in_review'));
  });

  test('says why a cancel from completed, or a move out of cancelled other than to To do, is refused', () => {
    assert.equal(cancellingProblem('done', 'cancelled'), CANCEL_FROM_OPEN_MESSAGE);
    assert.equal(cancellingProblem('cancelled', 'in_progress'), CANCELLED_TERMINAL_MESSAGE);
    assert.equal(cancellingProblem('cancelled', 'done'), CANCELLED_TERMINAL_MESSAGE);
    for (const from of ['todo', 'in_progress', 'blocked', 'in_review']) assert.equal(cancellingProblem(from, 'cancelled'), null, from);
    assert.equal(cancellingProblem('cancelled', 'todo'), null);
    assert.equal(cancellingProblem('todo', 'in_progress'), null);
  });

  test('maps the database refusals to the same sentences', () => {
    assert.equal(cancelOrArchiveDbProblem('task_cancel_from_open_only: a task is cancelled only while it is open (was done)'), CANCEL_FROM_OPEN_MESSAGE);
    assert.equal(cancelOrArchiveDbProblem('task_cancel_requires_owner_or_lead: x'), CANCEL_FORBIDDEN_MESSAGE);
    assert.equal(cancelOrArchiveDbProblem('task_cancelled_is_terminal: x'), CANCELLED_TERMINAL_MESSAGE);
    assert.equal(cancelOrArchiveDbProblem('task_archive_requires_roster_manager: x'), ARCHIVE_FORBIDDEN_MESSAGE);
    assert.equal(cancelOrArchiveDbProblem('something else'), null);
  });
});

describe('T1-1 a cancelled or archived task is not outstanding work', () => {
  const tasks = [
    { status: 'done' },
    { status: 'in_progress' },
    { status: 'todo' },
    { status: 'cancelled' },
    { status: 'todo', archivedAt: '2026-10-01T00:00:00Z' },
    { status: 'done', archivedAt: '2026-10-01T00:00:00Z' },
  ];

  test('counted means neither cancelled nor archived; outstanding also means not done', () => {
    assert.deepEqual(tasks.map(isCountedTask), [true, true, true, false, false, false]);
    assert.deepEqual(tasks.map(isOutstandingTask), [false, true, true, false, false, false]);
  });

  test('progress leaves them out of the denominator: one of three counted tasks is done', () => {
    assert.deepEqual(rollup(tasks), { total: 3, done: 1, percent: 33 });
  });

  test('a project whose only tasks are cancelled has no progress to report rather than 0 of N', () => {
    assert.deepEqual(rollup([{ status: 'cancelled' }, { status: 'todo', archivedAt: '2026-10-01T00:00:00Z' }]), { total: 0, done: 0, percent: 0 });
  });

  test("a person's workload does not carry them", () => {
    const summary = teamSummary({
      members: [{ userId: 'u1', fullName: 'Asha', orgRole: 'member', projectRole: 'developer' }],
      holders: [],
      todayKey: '2026-10-10',
      tasks: [
        { assigneeId: 'u1', status: 'todo', dueOn: '2026-10-01', estimateHours: 4 },
        { assigneeId: 'u1', status: 'cancelled', dueOn: '2026-10-01', estimateHours: 8 },
        { assigneeId: 'u1', status: 'blocked', dueOn: null, estimateHours: 2, archivedAt: '2026-10-02T00:00:00Z' },
        { assigneeId: 'u1', status: 'done', dueOn: null, estimateHours: 1 },
      ],
    });
    const asha = summary.people[0]!;
    assert.deepEqual({ total: asha.total, open: asha.open, overdue: asha.overdue, blocked: asha.blocked, done: asha.done, openHours: asha.openHours }, { total: 2, open: 1, overdue: 1, blocked: 0, done: 1, openHours: 4 });
  });
});

describe('T1-2 the roster service calls the audited doors and nothing else', () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let next: { outcome: string; member_id: string | null } = { outcome: 'added', member_id: 'm1' };
  const touchedTables: string[] = [];
  const client = {
    schema: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: [next], error: null };
      },
      from: (table: string) => {
        touchedTables.push(table);
        throw new Error('the roster service must not write the table directly');
      },
    }),
  };
  mock.module('@/lib/db/server', { exports: { createClient: async () => client } });
  mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ userId: 'u0', organizationId: 'o1' }) } });
  mock.module('@/lib/authz/permissions', { exports: { can: () => true } });

  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';
  const MEMBER = '33333333-3333-4333-8333-333333333333';

  test('add calls projects.add_project_member with the project, person and role', async () => {
    const { addProjectMember } = await import('../src/modules/projects/project-members-service.ts');
    next = { outcome: 'added', member_id: 'm1' };
    const result = await addProjectMember({ projectId: PROJECT, userId: USER, projectRole: 'qa' });
    assert.deepEqual(result, { ok: true, data: { memberId: 'm1' } });
    assert.deepEqual(calls.at(-1), { fn: 'add_project_member', args: { p_project_id: PROJECT, p_user_id: USER, p_project_role: 'qa' } });
  });

  test("the door's refusals come back as sentences, not as success", async () => {
    const { addProjectMember, removeProjectMember, setProjectMemberRole } = await import('../src/modules/projects/project-members-service.ts');
    next = { outcome: 'not_internal', member_id: null };
    const stranger = await addProjectMember({ projectId: PROJECT, userId: USER, projectRole: 'qa' });
    assert.equal(stranger.ok, false);
    next = { outcome: 'already_member', member_id: null };
    const twice = await addProjectMember({ projectId: PROJECT, userId: USER, projectRole: 'qa' });
    assert.ok(!twice.ok && twice.error.code === 'CONFLICT');
    next = { outcome: 'forbidden', member_id: null };
    const refused = await setProjectMemberRole({ memberId: MEMBER, projectRole: 'designer' });
    assert.ok(!refused.ok && refused.error.code === 'FORBIDDEN');
    const refusedRemove = await removeProjectMember({ memberId: MEMBER });
    assert.ok(!refusedRemove.ok && refusedRemove.error.code === 'FORBIDDEN');
  });

  test('change role and remove call their own doors', async () => {
    const { removeProjectMember, setProjectMemberRole } = await import('../src/modules/projects/project-members-service.ts');
    next = { outcome: 'changed', member_id: MEMBER };
    assert.equal((await setProjectMemberRole({ memberId: MEMBER, projectRole: 'designer' })).ok, true);
    assert.deepEqual(calls.at(-1), { fn: 'change_project_member_role', args: { p_member_id: MEMBER, p_project_role: 'designer' } });
    next = { outcome: 'removed', member_id: MEMBER };
    assert.equal((await removeProjectMember({ memberId: MEMBER })).ok, true);
    assert.deepEqual(calls.at(-1), { fn: 'remove_project_member', args: { p_member_id: MEMBER } });
    assert.deepEqual(touchedTables, []);
  });
});
