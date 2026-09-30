import assert from 'node:assert/strict';
import test from 'node:test';

import { teamSummary } from '../src/modules/projects/team-summary.ts';

const members = [
  { userId: 'u1', fullName: 'Asha', orgRole: 'delivery_lead', projectRole: 'project_manager' as const },
  { userId: 'u2', fullName: 'Ben', orgRole: 'member', projectRole: 'developer' as const },
  { userId: 'u3', fullName: 'Chen', orgRole: 'member', projectRole: 'designer' as const },
];

test('the roster is the members and the task holders, each person once', () => {
  const s = teamSummary({
    members,
    holders: [
      { userId: 'u2', fullName: 'Ben', role: 'member' },
      { userId: 'u9', fullName: 'Dev', role: 'contractor' },
    ],
    tasks: [],
    todayKey: '2026-10-06',
  });
  assert.equal(s.total, 4);
  assert.equal(s.onRoster, 3);
  assert.deepEqual(s.projectManagers, ['Asha']);
  assert.equal(s.specialists, 2);
  assert.deepEqual(Object.fromEntries(s.distribution), { 'Project manager': 1, Developer: 1, Designer: 1, 'Task holder (not on the roster)': 1 });
});

test('workload counts open, overdue and blocked work and the hours still open', () => {
  const s = teamSummary({
    members,
    holders: [],
    tasks: [
      { assigneeId: 'u2', status: 'in_progress', dueOn: '2026-10-01', estimateHours: 4 },
      { assigneeId: 'u2', status: 'blocked', dueOn: null, estimateHours: 2.5 },
      { assigneeId: 'u2', status: 'done', dueOn: '2026-09-01', estimateHours: 10 },
      { assigneeId: 'nobody', status: 'todo', dueOn: null, estimateHours: 1 },
      { assigneeId: null, status: 'todo', dueOn: null, estimateHours: 1 },
    ],
    todayKey: '2026-10-06',
  });
  const ben = s.people.find((p) => p.userId === 'u2');
  assert.deepEqual({ open: ben?.open, overdue: ben?.overdue, blocked: ben?.blocked, done: ben?.done, total: ben?.total, hours: ben?.openHours }, { open: 2, overdue: 1, blocked: 1, done: 1, total: 3, hours: 6.5 });
  assert.equal(s.people[0]?.userId, 'u2', 'the most loaded person comes first');
});
