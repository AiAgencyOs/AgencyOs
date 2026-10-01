import assert from 'node:assert/strict';
import test from 'node:test';

import { activityTypeChips, filterActivity, type ActivityRow } from '../src/modules/projects/project-activity.ts';
import { describeScheduleMove, scheduleChangeHref } from '../src/modules/projects/schedule-changes-queries-pure.ts';
import { enteringReviewProblem, REVIEW_HAND_OFF_MESSAGE, selectableStatuses } from '../src/modules/projects/task-transitions.ts';

const STATUSES = ['todo', 'in_progress', 'blocked', 'in_review', 'done'] as const;

test('a task enters review only through the hand-off: every other way in is refused with the sentence', () => {
  for (const from of ['todo', 'in_progress', 'blocked', 'done']) {
    assert.equal(enteringReviewProblem(from, 'in_review'), REVIEW_HAND_OFF_MESSAGE, `from ${from}`);
  }
  // Staying in review, and every move that is not into review, is not this rule's business.
  assert.equal(enteringReviewProblem('in_review', 'in_review'), null);
  for (const to of ['todo', 'in_progress', 'blocked', 'done']) assert.equal(enteringReviewProblem('in_review', to), null, `out to ${to}`);
  assert.equal(enteringReviewProblem('todo', 'in_progress'), null);
});

test('a status select never offers Review to a task that is not already there', () => {
  // Q-B1: Completed is offered only from In review (or where it already is).
  assert.deepEqual(selectableStatuses(STATUSES, 'todo'), ['todo', 'in_progress', 'blocked']);
  assert.deepEqual(selectableStatuses(STATUSES, 'in_review'), [...STATUSES]);
});

test('a date that moved reads as old to new, and a cleared or first date says so', () => {
  const date = (d: string) => `<${d}>`;
  assert.equal(describeScheduleMove({ wasOn: '2026-10-13', nowOn: '2026-10-20' }, date), '<2026-10-13> → <2026-10-20>');
  assert.equal(describeScheduleMove({ wasOn: null, nowOn: '2026-10-20' }, date), 'no date → <2026-10-20>');
  assert.equal(describeScheduleMove({ wasOn: '2026-10-13', nowOn: null }, date), '<2026-10-13> → no date');
});

test('a schedule change links to the thing that moved', () => {
  assert.equal(scheduleChangeHref({ kind: 'task', subjectId: 't1', projectId: 'p1' }), '/projects/p1/development/tasks/t1');
  assert.equal(scheduleChangeHref({ kind: 'milestone', subjectId: 'm1', projectId: 'p1' }), '/projects/p1/milestones?milestone=m1');
  assert.equal(scheduleChangeHref({ kind: 'project', subjectId: 'p1', projectId: 'p1' }), '/projects/p1/calendar');
});

const row = (key: string, subjectType: string, action: string, label: string, actor: string | null): ActivityRow => ({ key, at: '2026-10-01T00:00:00Z', source: 'audit', action, label, actor, subjectType, subjectId: key });

test('the activity timeline narrows by kind and by search over the action, the label and the actor', () => {
  const rows = [
    row('a', 'task', 'task.schedule_set', 'Fix login', 'Asha'),
    row('b', 'milestone', 'milestone.due_changed', 'M2 Design sign-off', 'Ben'),
    row('c', 'project_file', 'project_file.added', 'brief.pdf', 'Asha'),
    row('d', 'project_folder', 'project_folder.created', 'mockups', 'Chen'),
    row('e', 'something_new', 'x.y', 'odd', null),
  ];
  assert.deepEqual(activityTypeChips(rows).map((c) => `${c.label}:${c.count}`), ['Files:2', 'Milestones:1', 'Other:1', 'Tasks:1']);
  assert.deepEqual(filterActivity(rows, { type: 'Files' }).map((r) => r.key), ['c', 'd']);
  assert.deepEqual(filterActivity(rows, { q: 'asha' }).map((r) => r.key), ['a', 'c']);
  assert.deepEqual(filterActivity(rows, { q: 'due changed' }).map((r) => r.key), ['b']);
  assert.deepEqual(filterActivity(rows, { q: 'asha', type: 'Files' }).map((r) => r.key), ['c']);
  assert.deepEqual(filterActivity(rows, { type: 'Other' }).map((r) => r.key), ['e']);
  assert.equal(filterActivity(rows, {}).length, 5);
});
