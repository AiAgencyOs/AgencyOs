import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { clockFor } from '../src/lib/admin/clock.ts';

/**
 * Screens read in the agency's zone, not the runtime's.
 *
 * Every date in the admin panel used a bare `new Intl.DateTimeFormat(...)`,
 * which formats in the zone the process happens to run in. On a laptop that is
 * the agency's zone and the bug is invisible; on Vercel it is UTC. An agency in
 * Asia/Kolkata read every screen five and a half hours behind — a message sent
 * at 00:13 showed as 6:43 pm, under the *previous* day's divider.
 *
 * These run with an explicit zone on both sides, so they fail the same way on
 * any machine rather than passing wherever the developer happens to be.
 */

// 2026-08-20T18:43:00Z is 2026-08-21T00:13 in Asia/Kolkata — just past midnight.
const AFTER_MIDNIGHT = '2026-08-20T18:43:00.000Z';

describe('the agency clock reads in the agency’s zone', () => {
  test('a time is the office clock, not the server’s', () => {
    assert.equal(clockFor('Asia/Kolkata').clock(AFTER_MIDNIGHT), '12:13 am');
    assert.equal(clockFor('UTC').clock(AFTER_MIDNIGHT), '6:43 pm');
  });

  test('and the calendar day moves with it', () => {
    // The bug that mattered more than the clock face: the same instant is the
    // 21st in Kolkata and still the 20th in UTC, so the transcript filed a
    // message under yesterday.
    assert.equal(clockFor('Asia/Kolkata').dayKey(AFTER_MIDNIGHT), '2026-08-21');
    assert.equal(clockFor('UTC').dayKey(AFTER_MIDNIGHT), '2026-08-20');
  });

  test('a day key is ISO-ordered, so two of them compare as strings', () => {
    const clock = clockFor('Asia/Kolkata');
    assert.ok(clock.dayKey('2026-01-09T12:00:00Z') < clock.dayKey('2026-01-10T12:00:00Z'));
    assert.match(clock.dayKey(AFTER_MIDNIGHT), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('every formatter in the set uses the same zone — a page cannot mix two', () => {
    const clock = clockFor('Asia/Kolkata');
    assert.equal(clock.timeZone, 'Asia/Kolkata');
    // All five render the 21st, not the 20th.
    for (const rendered of [
      clock.date(AFTER_MIDNIGHT),
      clock.dateTime(AFTER_MIDNIGHT),
      clock.day(AFTER_MIDNIGHT),
    ]) {
      assert.match(rendered, /21/, rendered);
    }
    assert.equal(clock.weekday(AFTER_MIDNIGHT), 'Fri');
  });

  test('it accepts a Date as readily as an ISO string', () => {
    const clock = clockFor('Asia/Kolkata');
    assert.equal(clock.dayKey(new Date(AFTER_MIDNIGHT)), clock.dayKey(AFTER_MIDNIGHT));
  });
});
