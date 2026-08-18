import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cronIsStale, levelLabel, overallStatus, type Avail } from '../src/lib/admin/overview-eval.ts';
import type { BacklogRow } from '../src/lib/observability/backlog.ts';

const clean: BacklogRow = {
  dead_jobs: 0, stalled_jobs: 0, stuck_queued_jobs: 0, unpublished_events: 0, dead_events: 0,
  overdue_approvals: 0, oldest_dead_at: null, oldest_unpublished_at: null, oldest_overdue_due_at: null,
};
const ok = <T>(value: T): Avail<T> => ({ ok: true, value });
const unavailable: Avail<never> = { ok: false };

/**
 * The command center must never say "operational" on missing evidence. These
 * pin the load-bearing rule: a failed core read is `unknown`, not green.
 */
describe('overallStatus', () => {
  test('a clean backlog with a fresh cron and no failed sends is operational', () => {
    assert.equal(overallStatus({ backlog: ok(clean), cronAgeSeconds: 30, failedDeliveries: ok(0) }).level, 'operational');
  });

  test('an unreadable backlog is UNKNOWN, never operational (no false comfort)', () => {
    const r = overallStatus({ backlog: unavailable, cronAgeSeconds: 30, failedDeliveries: ok(0) });
    assert.equal(r.level, 'unknown');
    assert.notEqual(r.level, 'operational');
  });

  test('a dead job makes it failing', () => {
    assert.equal(overallStatus({ backlog: ok({ ...clean, dead_jobs: 1 }), cronAgeSeconds: 30, failedDeliveries: ok(0) }).level, 'failing');
  });

  test('a failed delivery makes it failing even when the backlog is clean', () => {
    assert.equal(overallStatus({ backlog: ok(clean), cronAgeSeconds: 30, failedDeliveries: ok(2) }).level, 'failing');
  });

  test('a stale cron degrades even a clean backlog', () => {
    assert.equal(overallStatus({ backlog: ok(clean), cronAgeSeconds: null, failedDeliveries: ok(0) }).level, 'degraded');
    assert.equal(overallStatus({ backlog: ok(clean), cronAgeSeconds: 3600, failedDeliveries: ok(0) }).level, 'degraded');
  });

  test('unavailable failed-delivery count is not treated as a failure', () => {
    // Missing evidence must not manufacture a "failing" verdict either.
    assert.equal(overallStatus({ backlog: ok(clean), cronAgeSeconds: 30, failedDeliveries: unavailable }).level, 'operational');
  });
});

describe('cronIsStale', () => {
  test('null (unknown) and >15m are stale; fresh is not', () => {
    assert.equal(cronIsStale(null), true);
    assert.equal(cronIsStale(16 * 60), true);
    assert.equal(cronIsStale(60), false);
  });
});

describe('levelLabel', () => {
  test('unknown reads as unavailable, not healthy', () => {
    assert.equal(levelLabel('unknown').tone, 'muted');
    assert.match(levelLabel('unknown').text, /unavailable/i);
    assert.equal(levelLabel('operational').tone, 'good');
  });
});
