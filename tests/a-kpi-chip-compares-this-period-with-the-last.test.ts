import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countPeriods, periodDelta, sumPeriods, trendOf } from '@/lib/admin/period-delta';

const now = new Date('2026-09-30T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

test('rows are split into the last 30 days and the 30 before, and anything older or in the future is ignored', () => {
  const counts = countPeriods([daysAgo(1), daysAgo(29), daysAgo(31), daysAgo(59), daysAgo(61), null, 'not a date', '2027-01-01T00:00:00Z'], now);
  assert.deepEqual(counts, { current: 2, previous: 2 });
});

test('amounts are summed per period', () => {
  const counts = sumPeriods([{ at: daysAgo(2), amount: 500 }, { at: daysAgo(10), amount: 250 }, { at: daysAgo(40), amount: 1000 }], now);
  assert.deepEqual(counts, { current: 750, previous: 1000 });
});

test('the chip is a rounded percentage with a direction', () => {
  assert.deepEqual(periodDelta({ current: 15, previous: 12 }), { direction: 'up', percent: 25, label: '25%' });
  assert.deepEqual(periodDelta({ current: 1, previous: 3 }), { direction: 'down', percent: -67, label: '67%' });
});

test('a rise from nothing says New, and an empty or unchanged pair says nothing', () => {
  assert.equal(periodDelta({ current: 4, previous: 0 })?.label, 'New');
  assert.equal(periodDelta({ current: 0, previous: 0 }), null);
  assert.equal(periodDelta({ current: 5, previous: 5 }), null);
  assert.equal(periodDelta({ current: 0, previous: 6 })?.direction, 'down');
});

test('a metric where less is better turns a fall green', () => {
  const fall = periodDelta({ current: 2, previous: 4 });
  assert.equal(trendOf(fall)?.tone, 'danger');
  assert.equal(trendOf(fall, true)?.tone, 'success');
  assert.equal(trendOf(null), undefined);
});
