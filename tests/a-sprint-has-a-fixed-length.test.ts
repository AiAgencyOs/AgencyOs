import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createSprintSchema, sprintDay, sprintEnd, sprintsOverlap, sprintState } from '../src/modules/projects/sprint-schema.ts';

describe('a sprint is a start and a fixed number of days; its last day is never stored', () => {
  test('the last day is inclusive, across month and year ends', () => {
    assert.equal(sprintEnd('2026-10-05', 14), '2026-10-18');
    assert.equal(sprintEnd('2026-10-05', 1), '2026-10-05');
    assert.equal(sprintEnd('2026-12-25', 14), '2027-01-07');
    assert.equal(sprintEnd('2028-02-20', 10), '2028-02-29');
  });

  test('a sprint is upcoming, active, ended-but-open or closed — closing beats the calendar', () => {
    const s = { startsOn: '2026-10-05', lengthDays: 14, closedAt: null };
    assert.equal(sprintState(s, '2026-10-04'), 'upcoming');
    assert.equal(sprintState(s, '2026-10-05'), 'active');
    assert.equal(sprintState(s, '2026-10-18'), 'active');
    assert.equal(sprintState(s, '2026-10-19'), 'ended');
    assert.equal(sprintState({ ...s, closedAt: '2026-10-10T00:00:00Z' }, '2026-10-06'), 'closed');
  });

  test('"day 3 of 14" only while the sprint is running', () => {
    const s = { startsOn: '2026-10-05', lengthDays: 14 };
    assert.deepEqual(sprintDay(s, '2026-10-07'), { day: 3, of: 14 });
    assert.deepEqual(sprintDay(s, '2026-10-18'), { day: 14, of: 14 });
    assert.equal(sprintDay(s, '2026-10-04'), null);
    assert.equal(sprintDay(s, '2026-10-19'), null);
  });

  test('two sprints overlap when they share a day — the rule the database applies to open sprints', () => {
    const a = { startsOn: '2026-10-05', lengthDays: 14 };
    assert.equal(sprintsOverlap(a, { startsOn: '2026-10-18', lengthDays: 7 }), true);
    assert.equal(sprintsOverlap(a, { startsOn: '2026-09-28', lengthDays: 8 }), true);
    assert.equal(sprintsOverlap(a, { startsOn: '2026-10-19', lengthDays: 14 }), false);
    assert.equal(sprintsOverlap(a, { startsOn: '2026-09-21', lengthDays: 14 }), false);
  });

  test('the form accepts 1 to 60 whole days and a named, dated sprint, and says why otherwise', () => {
    const base = { projectId: '00000000-0000-4000-8000-000000000001', name: ' Sprint 1 ', startsOn: '2026-10-05', lengthDays: 14 };
    const ok = createSprintSchema.safeParse(base);
    assert.equal(ok.success, true);
    assert.equal(ok.success && ok.data.name, 'Sprint 1');
    for (const lengthDays of [0, 61, 2.5]) assert.equal(createSprintSchema.safeParse({ ...base, lengthDays }).success, false, `${lengthDays} days`);
    assert.equal(createSprintSchema.safeParse({ ...base, name: '   ' }).success, false);
    assert.equal(createSprintSchema.safeParse({ ...base, startsOn: 'next monday' }).success, false);
  });
});
