import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Phase 8 observability reads: the database groups and counts, this file only reshapes the rows. A failed read is refused, an unknown metric is ignored (never
 * invented), and an age is whole days from the oldest timestamp, never negative.
 */

let outcome: { data: unknown; error: { message: string } | null } = { data: [], error: null };
let called: { schema: string; fn: string }[] = [];

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({ schema: (schema: string) => ({ rpc: async (fn: string) => { called.push({ schema, fn }); return outcome; } }) }),
  },
});

const { ageInDays, emptyObservability, readPhaseEightObservability, OBSERVABILITY_METRICS } = await import('../src/modules/projects/phase-eight-observability-queries.ts');

beforeEach(() => {
  outcome = { data: [], error: null };
  called = [];
});

describe('the observability read', () => {
  test('rows are grouped under their metric with the count and the oldest time; the one database function is called', async () => {
    outcome = {
      data: [
        { metric: 'tickets_by_state', bucket: 'closed', n: 4, oldest_at: '2026-09-01T00:00:00Z' },
        { metric: 'tickets_by_state', bucket: 'assigned', n: 2, oldest_at: '2026-10-01T00:00:00Z' },
        { metric: 'health_distribution', bucket: 'at_risk', n: 1, oldest_at: null },
        { metric: 'something_invented', bucket: 'x', n: 9, oldest_at: null },
      ],
      error: null,
    };
    const data = await readPhaseEightObservability();
    assert.deepEqual(called, [{ schema: 'projects', fn: 'phase_eight_observability' }]);
    assert.deepEqual(data.tickets_by_state, [{ bucket: 'closed', count: 4, oldestAt: '2026-09-01T00:00:00Z' }, { bucket: 'assigned', count: 2, oldestAt: '2026-10-01T00:00:00Z' }]);
    assert.deepEqual(data.health_distribution, [{ bucket: 'at_risk', count: 1, oldestAt: null }]);
    assert.equal(Object.keys(data).length, OBSERVABILITY_METRICS.length, 'an unknown metric is not added');
    assert.deepEqual(data.recovery_plans, []);
  });

  test('an empty answer is an empty dashboard; a failed read is refused, in words that carry none of the driver\'s', async () => {
    assert.deepEqual(await readPhaseEightObservability(), emptyObservability());
    outcome = { data: null, error: { message: 'could not connect to server' } };
    await assert.rejects(readPhaseEightObservability, (e: Error) => {
      assert.match(e.message, /could not be read/);
      assert.doesNotMatch(e.message, /connect|server/);
      return true;
    });
  });
});

describe('ages', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  test('whole days from the oldest timestamp; none without one; never negative', () => {
    assert.equal(ageInDays('2026-10-07T12:00:00Z', now), 3);
    assert.equal(ageInDays('2026-10-10T11:00:00Z', now), 0);
    assert.equal(ageInDays('2026-10-12T00:00:00Z', now), 0);
    assert.equal(ageInDays(null, now), null);
    assert.equal(ageInDays('not a date', now), null);
  });
});
