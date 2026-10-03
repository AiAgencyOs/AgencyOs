import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { composeRecentActivity, resourceBars } from '../src/modules/projects/report-cards.ts';

describe('recent activity is composed from dated rows, newest first', () => {
  test('undated work is left out and the list is cut to the limit', () => {
    const out = composeRecentActivity(
      {
        tasks: [{ id: 't1', title: 'Login', completedAt: '2026-09-03T00:00:00Z', assigneeName: 'Amit' }, { id: 't2', title: 'Open', completedAt: null }],
        milestones: [{ id: 'm1', name: 'Kick-off', met_at: '2026-09-05T00:00:00Z' }, { id: 'm2', name: 'Later', met_at: null }],
        defects: [{ id: 'd1', title: 'Crash', created_at: '2026-09-04T00:00:00Z' }],
        files: [{ id: 'f1', title: 'brief.pdf', createdAt: '2026-09-01T00:00:00Z', uploadedByName: 'Sonu' }],
      },
      3,
    );
    assert.deepEqual(out.map((e) => e.key), ['m-m1', 'd-d1', 't-t1']);
    assert.equal(out[2]!.who, 'Amit');
  });
});

describe('resource usage is hours per person relative to the busiest', () => {
  test('busiest is 100%, zero hours drop out, and nothing logged is empty', () => {
    const bars = resourceBars([{ personName: 'A', hours: 4 }, { personName: 'B', hours: 8 }, { personName: 'C', hours: 0 }]);
    assert.deepEqual(bars.map((b) => [b.name, b.percentOfBusiest]), [['B', 100], ['A', 50]]);
    assert.deepEqual(resourceBars([]), []);
  });
});
