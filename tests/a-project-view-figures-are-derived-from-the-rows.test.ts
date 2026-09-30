import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  daysBetween,
  dueLine,
  groupKeyOf,
  groupsFor,
  inclusiveDays,
  phaseState,
  phaseWindow,
  progressSeries,
  rollup,
  taskWindow,
  topLevelTasks,
} from '../src/modules/projects/project-view-derive.ts';
import { parseLabels } from '../src/modules/projects/task-plan-schema.ts';

const none = { assignees: new Map<string, string>(), modules: new Map<string, string>(), phases: new Map<string, string>() };

describe('progress over time is counted from completed_at and due_on', () => {
  const tasks = [
    { dueOn: '2026-09-05', completedAt: '2026-09-04T10:00:00Z' },
    { dueOn: '2026-09-10', completedAt: '2026-09-12T10:00:00Z' },
    { dueOn: '2026-09-20', completedAt: null },
    { dueOn: null, completedAt: null },
  ];
  const series = progressSeries(tasks, { start: '2026-09-01', end: '2026-09-21' }, '2026-09-15', 5);

  it('samples the window evenly from its start to its end', () => {
    assert.deepEqual(series.map((p) => p.key), ['2026-09-01', '2026-09-06', '2026-09-11', '2026-09-16', '2026-09-21']);
  });

  it('actual is the share completed by that day, and stops at today', () => {
    assert.deepEqual(series.map((p) => p.actual), [0, 25, 25, null, null]);
  });

  it('planned is the share due by that day, over the same denominator', () => {
    assert.deepEqual(series.map((p) => p.planned), [0, 25, 50, 50, 75]);
  });

  it('is empty for a project with no tasks — nothing to draw, nothing invented', () => {
    assert.deepEqual(progressSeries([], { start: null, end: null }, '2026-09-15'), []);
  });

  it('without a project window it spans the task dates and today', () => {
    const s = progressSeries(tasks, { start: null, end: null }, '2026-09-15', 3);
    assert.equal(s[0]!.key, '2026-09-04');
    assert.equal(s.at(-1)!.key, '2026-09-20');
  });
});

describe('grouping the board', () => {
  const a = { status: 'todo', assigneeId: 'u1', priority: 'p1', moduleId: null, milestoneId: 'm2' };
  const b = { status: 'done', assigneeId: null, priority: 'p0', moduleId: 'mod', milestoneId: null };
  const c = { status: 'in_progress', assigneeId: 'u1', priority: 'p3', moduleId: 'mod', milestoneId: 'm1' };
  const order = { statuses: ['todo', 'in_progress', 'in_review', 'done'], phases: ['m1', 'm2'] };

  it('keys a task by each grouping, with none for the missing one', () => {
    assert.equal(groupKeyOf(a, 'status'), 'todo');
    assert.equal(groupKeyOf(b, 'assignee'), 'none');
    assert.equal(groupKeyOf(a, 'module'), 'none');
    assert.equal(groupKeyOf(b, 'phase'), 'none');
  });

  it('orders phases by the plan, priorities from critical down, and puts none last', () => {
    const labels = { ...none, phases: new Map([['m1', 'Phase 1'], ['m2', 'Phase 2']]) };
    assert.deepEqual(groupsFor([a, b, c], 'phase', labels, order).map((g) => g.label), ['Phase 1', 'Phase 2', 'No phase']);
    assert.deepEqual(groupsFor([a, b, c], 'priority', none, order).map((g) => g.label), ['Critical', 'High', 'Low']);
  });

  it('names people and modules, alphabetically, unknowns honestly', () => {
    const labels = { ...none, assignees: new Map([['u1', 'Amit Gupta']]) };
    assert.deepEqual(groupsFor([a, b, c], 'assignee', labels, order).map((g) => g.label), ['Amit Gupta', 'Unassigned']);
    assert.deepEqual(groupsFor([b], 'module', none, order).map((g) => g.label), ['Unknown module']);
  });

  it('drops subtasks from a top-level list', () => {
    assert.equal(topLevelTasks([{ parentTaskId: null }, { parentTaskId: 'x' }]).length, 1);
  });
});

describe('timeline windows stand on stored dates only', () => {
  it('a task runs start to due, a lone date is a one-day bar, no dates is no bar', () => {
    assert.deepEqual(taskWindow({ startOn: '2026-09-01', dueOn: '2026-09-03' }), { start: '2026-09-01', end: '2026-09-03' });
    assert.deepEqual(taskWindow({ startOn: null, dueOn: '2026-09-03' }), { start: '2026-09-03', end: '2026-09-03' });
    assert.equal(taskWindow({ startOn: null, dueOn: null }), null);
  });

  const phase = { id: 'p', name: 'Phase 2', dueOn: '2026-09-20', metAt: null, status: 'pending' };

  it('a phase spans its tasks, else opens the day after the previous phase closed', () => {
    assert.deepEqual(phaseWindow(phase, '2026-09-10', '2026-09-01', [{ startOn: '2026-09-12', dueOn: '2026-09-15' }]), { start: '2026-09-12', end: '2026-09-20' });
    assert.deepEqual(phaseWindow(phase, '2026-09-10', '2026-09-01', []), { start: '2026-09-11', end: '2026-09-20' });
    assert.deepEqual(phaseWindow(phase, null, '2026-09-01', []), { start: '2026-09-01', end: '2026-09-20' });
  });

  it('a phase with no due date borrows its tasks\' last day, and with nothing is not drawn', () => {
    assert.deepEqual(phaseWindow({ ...phase, dueOn: null }, null, null, [{ startOn: '2026-09-02', dueOn: '2026-09-09' }]), { start: '2026-09-02', end: '2026-09-09' });
    assert.equal(phaseWindow({ ...phase, dueOn: null }, null, '2026-09-01', []), null);
  });

  it('states: met is done, a passed due date is late, work under way is current', () => {
    const idle = rollup([{ status: 'todo' }]);
    assert.equal(phaseState({ ...phase, metAt: '2026-09-19T00:00:00Z' }, idle, '2026-09-25', false), 'done');
    assert.equal(phaseState(phase, idle, '2026-09-25', false), 'late');
    assert.equal(phaseState(phase, idle, '2026-09-15', true), 'current');
    assert.equal(phaseState(phase, rollup([{ status: 'done' }]), '2026-09-15', false), 'current');
    assert.equal(phaseState(phase, idle, '2026-09-15', false), 'upcoming');
  });
});

describe('the small sums', () => {
  it('rolls a set of tasks up to done / total / percent', () => {
    assert.deepEqual(rollup([{ status: 'done' }, { status: 'todo' }, { status: 'done' }]), { total: 3, done: 2, percent: 67 });
    assert.deepEqual(rollup([]), { total: 0, done: 0, percent: 0 });
  });

  it('counts days and words the due line', () => {
    assert.equal(daysBetween('2026-09-01', '2026-09-08'), 7);
    assert.equal(inclusiveDays('2026-09-01', '2026-09-07'), 7);
    assert.equal(dueLine('2026-09-10', '2026-09-01'), '9 days left');
    assert.equal(dueLine('2026-09-02', '2026-09-01'), '1 day left');
    assert.equal(dueLine('2026-09-01', '2026-09-01'), 'Due today');
    assert.equal(dueLine('2026-08-30', '2026-09-01'), '2 days overdue');
    assert.equal(dueLine(null, '2026-09-01'), 'No due date');
  });

  it('splits a label field on commas and new lines, dropping blanks', () => {
    assert.deepEqual(parseLabels(' Feature, Backend ,,\nUI/UX '), ['Feature', 'Backend', 'UI/UX']);
    assert.deepEqual(parseLabels('  '), []);
  });
});
