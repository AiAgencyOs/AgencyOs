import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_REMINDER_LEAD_MINUTES,
  clampLeadMinutes,
  reminderDedupeKey,
  reminderDueAt,
  reminderVerdict,
  type MeetingNow,
  type ReminderJob,
} from '../src/lib/scheduling/reminders.ts';

/**
 * A reminder for a meeting that moved — gap G-228.
 *
 * §7.2 asks a reminder to do five things and three of them are about being
 * WRONG by the time it fires: re-check the schedule immediately before
 * sending, suppress for cancelled events, replace after rescheduling.
 *
 * This is G-191 again with a worse blast radius. There, the sending window was
 * applied when a follow-up was scheduled and never again, so a message
 * computed at 18:00 arrived at three in the morning. Here the client has been
 * told somebody is coming.
 *
 * Every rule is a pure function, so every test executes one. No source is read
 * in this file at all.
 */

const START = '2026-09-14T15:00:00.000Z';
const booked = (over: Partial<MeetingNow> = {}): MeetingNow => ({
  status: 'booked',
  confirmedStartAt: START,
  ...over,
});
const job = (over: Partial<ReminderJob> = {}): ReminderJob => ({
  meetingId: 'm-1',
  scheduledForStartAt: START,
  leadMinutes: 10,
  ...over,
});

/** 10 minutes before START. */
const DUE = '2026-09-14T14:50:00.000Z';

describe('A. when a reminder should run', () => {
  test('ten minutes before a booked meeting', () => {
    assert.equal(reminderDueAt(booked(), 10), DUE);
  });

  test('an unbooked meeting has nothing to count back from', () => {
    // Inventing one is how a reminder fires for a meeting nobody agreed to.
    for (const status of ['requested', 'proposed', 'cancelled', 'completed', 'no_show'] as const) {
      assert.equal(reminderDueAt(booked({ status }), 10), null, `${status} produced a due time`);
    }
  });

  test('a booking with no start time produces nothing rather than a guess', () => {
    assert.equal(reminderDueAt(booked({ confirmedStartAt: null }), 10), null);
    assert.equal(reminderDueAt(booked({ confirmedStartAt: 'not-a-time' }), 10), null);
  });

  test('a lead time of zero or less is not a reminder', () => {
    assert.equal(reminderDueAt(booked(), 0), null);
    assert.equal(reminderDueAt(booked(), -5), null);
  });
});

describe('B. the re-check refuses what has changed', () => {
  test('a cancelled meeting is suppressed, whatever the clock says', () => {
    // §7.2. Ordered first deliberately: cancelled is cancelled even at the
    // exact moment the reminder was due.
    assert.equal(reminderVerdict(job(), booked({ status: 'cancelled' }), DUE), 'cancelled');
  });

  test('a meeting that is no longer booked is suppressed too', () => {
    for (const status of ['requested', 'proposed', 'completed', 'no_show'] as const) {
      assert.equal(reminderVerdict(job(), booked({ status }), DUE), 'not_booked');
    }
  });

  test('a meeting that MOVED suppresses the reminder about its old time', () => {
    // The case the status check cannot catch: still booked, still valid, just
    // not when this reminder thought. The reminder computed for the new time
    // is the one that should fire.
    const moved = booked({ confirmedStartAt: '2026-09-14T17:00:00.000Z' });

    assert.equal(reminderVerdict(job(), moved, DUE), 'moved');
  });

  test('and it is stale whether or not its old time has arrived', () => {
    const moved = booked({ confirmedStartAt: '2026-09-14T17:00:00.000Z' });

    assert.equal(reminderVerdict(job(), moved, '2026-09-14T10:00:00.000Z'), 'moved');
    assert.equal(reminderVerdict(job(), moved, '2026-09-14T16:00:00.000Z'), 'moved');
  });

  test('a booking that lost its start time is not sent against a guess', () => {
    assert.equal(reminderVerdict(job(), booked({ confirmedStartAt: null }), DUE), 'not_booked');
  });

  test('a clock that does not parse is refused rather than compared', () => {
    // Every arithmetic branch below needs a number for `now`; without one the
    // verdict cannot be 'send', and it says why rather than falling through.
    assert.equal(reminderVerdict(job(), booked(), 'not-a-clock'), 'not_booked');
    assert.equal(reminderVerdict(job(), booked(), ''), 'not_booked');
  });

  test('the same instant rendered two ways is not a move', () => {
    // Review: the first draft compared the strings, so a payload rendered by
    // Postgres (+05:30, six fractional digits) against a row normalised by
    // the client (Z, three) answered 'moved' for a meeting that had not.
    const jobAt = job();
    const sameInstant = booked({ confirmedStartAt: new Date(Date.parse(jobAt.scheduledForStartAt)).toISOString().replace('.000Z', '.000000+00:00') });
    assert.notEqual(sameInstant.confirmedStartAt, jobAt.scheduledForStartAt, 'the fixture really is a different rendering');
    assert.equal(reminderVerdict(jobAt, sameInstant, DUE), 'send');
    const unparseable = booked({ confirmedStartAt: 'not a time' });
    assert.equal(reminderVerdict(jobAt, unparseable, DUE), 'not_booked');
  });
});

describe('C. the window, once nothing has changed', () => {
  test('at the moment it is due, it sends', () => {
    assert.equal(reminderVerdict(job(), booked(), DUE), 'send');
  });

  test('a minute early is too early — the queue ran ahead of itself', () => {
    assert.equal(reminderVerdict(job(), booked(), '2026-09-14T14:49:00.000Z'), 'too_early');
  });

  test('between due and the start, it still sends', () => {
    assert.equal(reminderVerdict(job(), booked(), '2026-09-14T14:55:00.000Z'), 'send');
    assert.equal(reminderVerdict(job(), booked(), START), 'send');
  });

  test('after the meeting began, it is too late rather than late', () => {
    // A reminder then is not a reminder — it is a message telling somebody to
    // attend a thing they are already late for.
    assert.equal(reminderVerdict(job(), booked(), '2026-09-14T15:10:00.000Z'), 'too_late');
  });

  test('the grace period is the caller’s, and a wider one still sends', () => {
    const at = '2026-09-14T15:05:00.000Z';

    assert.equal(reminderVerdict(job(), booked(), at), 'too_late');
    assert.equal(reminderVerdict(job(), booked(), at, 10), 'send');
  });

  test('a longer lead time opens the window earlier, and only that', () => {
    const early = job({ leadMinutes: 60 });

    assert.equal(reminderVerdict(early, booked(), '2026-09-14T14:00:00.000Z'), 'send');
    assert.equal(reminderVerdict(early, booked(), '2026-09-14T13:59:00.000Z'), 'too_early');
    assert.equal(reminderVerdict(early, booked(), '2026-09-14T15:10:00.000Z'), 'too_late');
  });
});

describe('D. refusals are ordered by what matters, not by what is cheap', () => {
  test('cancelled beats moved', () => {
    const cancelledAndMoved = { status: 'cancelled' as const, confirmedStartAt: '2026-09-14T17:00:00.000Z' };

    assert.equal(reminderVerdict(job(), cancelledAndMoved, DUE), 'cancelled');
  });

  test('moved beats the clock', () => {
    // A moved reminder is stale at every hour, so answering too_early for it
    // would invite a caller to retry a reminder that must never fire.
    const moved = booked({ confirmedStartAt: '2026-09-14T17:00:00.000Z' });

    assert.equal(reminderVerdict(job(), moved, '2026-09-14T09:00:00.000Z'), 'moved');
  });

  test('nothing but send is ever send', () => {
    // The property, swept: of every combination below, exactly the unchanged
    // booked one at a time inside its window sends.
    const cases: [MeetingNow, string][] = [
      [booked({ status: 'cancelled' }), DUE],
      [booked({ status: 'completed' }), DUE],
      [booked({ confirmedStartAt: '2026-09-14T17:00:00.000Z' }), DUE],
      [booked(), '2026-09-14T00:00:00.000Z'],
      [booked(), '2026-09-15T00:00:00.000Z'],
      [booked(), DUE],
    ];
    const verdicts = cases.map(([m, now]) => reminderVerdict(job(), m, now));

    assert.equal(verdicts.filter((v) => v === 'send').length, 1);
    assert.equal(verdicts[verdicts.length - 1], 'send');
  });
});

describe('E. the key that makes rescheduling replace rather than accumulate', () => {
  test('it is stable for one meeting and one lead time', () => {
    assert.equal(reminderDedupeKey('m-1', 10), reminderDedupeKey('m-1', 10));
  });

  test('and it does NOT carry the start time', () => {
    // A key carrying the start would mint a fresh job every time a meeting
    // moved and leave the old one queued — the accumulation §7.2's "replace
    // obsolete reminders" exists to prevent. The start travels in the payload,
    // where reminderVerdict reads it.
    assert.ok(!reminderDedupeKey('m-1', 10).includes('2026'));
    assert.equal(reminderDedupeKey('m-1', 10), 'meeting.reminder:m-1:10');
  });

  test('two lead times are two reminders, not one overwriting the other', () => {
    // §7.2 permits an Admin reminder and a client reminder at different
    // offsets; they must not collide.
    assert.notEqual(reminderDedupeKey('m-1', 10), reminderDedupeKey('m-1', 60));
  });

  test('and two meetings never share a key', () => {
    assert.notEqual(reminderDedupeKey('m-1', 10), reminderDedupeKey('m-2', 10));
  });
});

describe('F. the configured lead time', () => {
  test('the default is inside the range the owner named', () => {
    // Sales Flow §6: "approximately 5–10 minutes before", and "exact policy
    // can be configurable". The default is the end of the range they named,
    // and it is a default rather than a rule.
    assert.equal(DEFAULT_REMINDER_LEAD_MINUTES, 10);
    assert.ok(DEFAULT_REMINDER_LEAD_MINUTES >= 5 && DEFAULT_REMINDER_LEAD_MINUTES <= 10);
  });

  test('an unset value falls back rather than disabling reminders', () => {
    assert.equal(clampLeadMinutes(null), 10);
    assert.equal(clampLeadMinutes(undefined), 10);
  });

  test('zero would mean "remind at the meeting", so it is floored at one', () => {
    assert.equal(clampLeadMinutes(0), 1);
    assert.equal(clampLeadMinutes(-30), 1);
  });

  test('a day ahead is the far end of useful', () => {
    assert.equal(clampLeadMinutes(1_440), 1_440);
    assert.equal(clampLeadMinutes(10_000), 1_440);
  });

  test('a fractional value is truncated rather than producing fractional minutes', () => {
    assert.equal(clampLeadMinutes(10.9), 10);
  });

  test('a value that is not a number falls back instead of poisoning the schedule', () => {
    assert.equal(clampLeadMinutes(Number.NaN), 10);
    assert.equal(clampLeadMinutes(Number.POSITIVE_INFINITY), 10);
  });
});
