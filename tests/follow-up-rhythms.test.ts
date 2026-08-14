import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  RHYTHM_DAYS,
  WINDOW_END_HOUR,
  WINDOW_START_HOUR,
  intoSendingWindow,
  maxAttempts,
  nextSendAt,
  type Rhythm,
} from '../src/modules/crm/follow-up-rhythms.ts';

/**
 * When a follow-up is due — decision ADM-69, gap G-012.
 *
 * ADM-69's values are used here as recorded, not reinterpreted, so the first
 * tests are simply that they *are* the recorded values. The rest are the cases
 * that arithmetic like this gets wrong: weekends, the window edges, daylight
 * saving, and the SLA that outranks the attempt count.
 */

const IST = 'Asia/Kolkata'; // no daylight saving
const LON = 'Europe/London'; // has it, and changes at 01:00 UTC
const NYC = 'America/New_York';

/** The local wall clock, as a string, so failures read as times rather than epochs. */
const localOf = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);

const hourIn = (d: Date, tz: string) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));

const weekdayIn = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);

describe('A. the recorded values are the values', () => {
  test('the four rhythms are exactly what ADM-69 records', () => {
    assert.deepEqual(RHYTHM_DAYS.sales_active, [2, 5, 8, 11, 14, 17, 20]);
    assert.deepEqual(RHYTHM_DAYS.sales_nurture, [7, 14, 21, 28, 35, 42, 49]);
    assert.deepEqual(RHYTHM_DAYS.customer_success, [7, 21]);
    assert.deepEqual(RHYTHM_DAYS.internal_approval, [1, 2, 3]);
  });

  test('day 0 is the trigger and is never an attempt', () => {
    // Stated in ADM-69 and easy to lose: an off-by-one here sends on the day
    // the client wrote in, which reads as an automated reply to their message.
    for (const days of Object.values(RHYTHM_DAYS)) {
      assert.ok(!days.includes(0), 'a rhythm fires on day 0');
    }
  });

  test('the maxima are 7 where the owner raised them, and 2 where two are listed', () => {
    // The correction: the first draft said "maximum 3" while listing two sends.
    assert.equal(maxAttempts('sales_active'), 7);
    assert.equal(maxAttempts('sales_nurture'), 7);
    assert.equal(maxAttempts('customer_success'), 2);
  });

  test('and Sales-Nurture really is weekly from 7 to 49', () => {
    const days = RHYTHM_DAYS.sales_nurture;
    for (let i = 1; i < days.length; i += 1) {
      assert.equal((days[i] ?? 0) - (days[i - 1] ?? 0), 7, 'the nurture rhythm is not weekly');
    }
  });
});

describe('B. every send lands on a business day, inside the window', () => {
  const trigger = new Date('2026-08-14T06:30:00Z'); // Friday

  for (const rhythm of Object.keys(RHYTHM_DAYS) as Rhythm[]) {
    test(`${rhythm}: every attempt is Mon–Fri, 10:00–19:00`, () => {
      for (let attempt = 0; attempt < maxAttempts(rhythm); attempt += 1) {
        const at = nextSendAt({ triggeredAt: trigger, rhythm, attemptsSoFar: attempt, timeZone: IST });
        assert.ok(at, `${rhythm} attempt ${attempt} produced nothing`);
        const day = weekdayIn(at, IST);
        assert.ok(!['Sat', 'Sun'].includes(day), `${rhythm} attempt ${attempt} lands on ${day}`);
        const hour = hourIn(at, IST);
        assert.ok(
          hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR,
          `${rhythm} attempt ${attempt} lands at ${hour}:00 (${localOf(at, IST)})`,
        );
      }
    });
  }

  test('and attempts strictly increase in time', () => {
    let previous = 0;
    for (let attempt = 0; attempt < maxAttempts('sales_active'); attempt += 1) {
      const at = nextSendAt({ triggeredAt: trigger, rhythm: 'sales_active', attemptsSoFar: attempt, timeZone: IST });
      assert.ok(at && at.getTime() > previous, `attempt ${attempt} is not after the one before`);
      previous = at.getTime();
    }
  });
});

describe('C. the window moves work later, never earlier', () => {
  test('before 10:00 on a weekday waits for 10:00 that day', () => {
    const early = new Date('2026-08-17T02:00:00Z'); // Monday 07:30 IST
    const moved = intoSendingWindow(early, IST);
    assert.ok(moved.getTime() > early.getTime(), 'the send was brought forward');
    assert.equal(hourIn(moved, IST), WINDOW_START_HOUR);
    assert.equal(weekdayIn(moved, IST), 'Mon');
  });

  test('inside the window is left exactly alone', () => {
    const inside = new Date('2026-08-17T08:00:00Z'); // Monday 13:30 IST
    assert.equal(intoSendingWindow(inside, IST).getTime(), inside.getTime());
  });

  test('after 19:00 waits for the next business day', () => {
    const late = new Date('2026-08-17T16:00:00Z'); // Monday 21:30 IST
    const moved = intoSendingWindow(late, IST);
    assert.equal(weekdayIn(moved, IST), 'Tue');
    assert.equal(hourIn(moved, IST), WINDOW_START_HOUR);
  });

  test('a Saturday waits for Monday, not Sunday', () => {
    const saturday = new Date('2026-08-15T08:00:00Z');
    const moved = intoSendingWindow(saturday, IST);
    assert.equal(weekdayIn(moved, IST), 'Mon');
  });

  test('and a Sunday waits for Monday too', () => {
    const sunday = new Date('2026-08-16T08:00:00Z');
    assert.equal(weekdayIn(intoSendingWindow(sunday, IST), IST), 'Mon');
  });
});

describe('D. daylight saving is handled by the zone, not by arithmetic', () => {
  test('10:00 local stays 10:00 local across a UK clock change', () => {
    // 2026-10-25 is when the UK leaves BST. A scheduler that added a fixed
    // offset would send at 09:00 for half the year.
    const before = new Date('2026-10-23T09:00:00Z'); // Friday, BST
    for (let attempt = 0; attempt < maxAttempts('sales_active'); attempt += 1) {
      const at = nextSendAt({ triggeredAt: before, rhythm: 'sales_active', attemptsSoFar: attempt, timeZone: LON });
      assert.ok(at);
      const hour = hourIn(at, LON);
      assert.ok(hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR, `landed at ${localOf(at, LON)}`);
    }
  });

  test('and the same across a US change, in the other direction', () => {
    const before = new Date('2026-10-30T14:00:00Z');
    for (let attempt = 0; attempt < maxAttempts('sales_nurture'); attempt += 1) {
      const at = nextSendAt({ triggeredAt: before, rhythm: 'sales_nurture', attemptsSoFar: attempt, timeZone: NYC });
      assert.ok(at);
      const hour = hourIn(at, NYC);
      assert.ok(hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR, `landed at ${localOf(at, NYC)}`);
    }
  });

  test('two zones give different instants for the same rhythm', () => {
    // The whole reason the zone is a required argument. If these agreed, the
    // parameter would be doing nothing.
    const trigger = new Date('2026-08-14T06:00:00Z');
    const a = nextSendAt({ triggeredAt: trigger, rhythm: 'sales_active', attemptsSoFar: 0, timeZone: IST });
    const b = nextSendAt({ triggeredAt: trigger, rhythm: 'sales_active', attemptsSoFar: 0, timeZone: NYC });
    assert.ok(a && b);
    assert.notEqual(a.getTime(), b.getTime());
  });
});

describe('E. a rhythm ends', () => {
  const trigger = new Date('2026-08-14T06:00:00Z');

  test('there is nothing after the last attempt', () => {
    for (const rhythm of Object.keys(RHYTHM_DAYS) as Rhythm[]) {
      const past = nextSendAt({ triggeredAt: trigger, rhythm, attemptsSoFar: maxAttempts(rhythm), timeZone: IST });
      assert.equal(past, null, `${rhythm} kept going past its last attempt`);
    }
  });

  test('Customer-Success stops after two, not seven', () => {
    // The maxima were raised to 7 for the two sales rhythms only. Applying it
    // to Customer-Success would send five messages nobody decided to send.
    assert.ok(nextSendAt({ triggeredAt: trigger, rhythm: 'customer_success', attemptsSoFar: 1, timeZone: IST }));
    assert.equal(nextSendAt({ triggeredAt: trigger, rhythm: 'customer_success', attemptsSoFar: 2, timeZone: IST }), null);
  });

  test('and a negative attempt count is refused rather than wrapped', () => {
    assert.equal(nextSendAt({ triggeredAt: trigger, rhythm: 'sales_active', attemptsSoFar: -1, timeZone: IST }), null);
  });
});

describe('F. the SLA outranks the reminder count', () => {
  const trigger = new Date('2026-08-17T05:00:00Z'); // Monday

  test('a reminder that would land after the SLA is not scheduled', () => {
    // ADM-69 resolved this explicitly: three reminders at one business day
    // each would otherwise chase a request the system already considers
    // expired.
    const soon = new Date('2026-08-17T12:00:00Z'); // hours later, same day
    const at = nextSendAt({
      triggeredAt: trigger, rhythm: 'internal_approval', attemptsSoFar: 0, timeZone: IST, slaDueAt: soon,
    });
    assert.equal(at, null);
  });

  test('but one that lands before it is', () => {
    const far = new Date('2026-09-30T00:00:00Z');
    const at = nextSendAt({
      triggeredAt: trigger, rhythm: 'internal_approval', attemptsSoFar: 0, timeZone: IST, slaDueAt: far,
    });
    assert.ok(at);
    assert.ok(at.getTime() < far.getTime());
  });

  test('the SLA cuts a rhythm short mid-way, not only at the start', () => {
    // The realistic case: the first reminder fits, the third does not.
    const sla = new Date('2026-08-19T06:00:00Z');
    const first = nextSendAt({ triggeredAt: trigger, rhythm: 'internal_approval', attemptsSoFar: 0, timeZone: IST, slaDueAt: sla });
    const third = nextSendAt({ triggeredAt: trigger, rhythm: 'internal_approval', attemptsSoFar: 2, timeZone: IST, slaDueAt: sla });
    assert.ok(first, 'the first reminder should still fit');
    assert.equal(third, null, 'the third reminder outlived the SLA');
  });

  test('and no SLA means the count alone decides', () => {
    const at = nextSendAt({ triggeredAt: trigger, rhythm: 'internal_approval', attemptsSoFar: 2, timeZone: IST });
    assert.ok(at, 'without an SLA the third reminder should be scheduled');
  });
});

describe('G. the same inputs always give the same answer', () => {
  test('scheduling is pure, so a retry cannot drift', () => {
    // A scheduler that reads the clock inside the calculation produces a
    // different answer on every retry, and duplicate sends follow.
    const trigger = new Date('2026-08-14T06:00:00Z');
    const once = nextSendAt({ triggeredAt: trigger, rhythm: 'sales_active', attemptsSoFar: 3, timeZone: IST });
    const twice = nextSendAt({ triggeredAt: trigger, rhythm: 'sales_active', attemptsSoFar: 3, timeZone: IST });
    assert.equal(once?.getTime(), twice?.getTime());
  });
});
