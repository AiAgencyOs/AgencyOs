import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

import {
  filterSlots,
  offerableSlots,
  proposableSlots,
  rankSlots,
  readAvailability,
  type AvailabilityAnswer,
  type Slot,
} from '../src/lib/scheduling/availability.ts';

/**
 * A slot that was never read — gap G-226.
 *
 * The Scheduler specification opens its "must not" list with one line:
 * "Invent availability." This is the machinery that makes that enforceable
 * rather than aspirational, and every part of it is a pure function, so every
 * part of it is executed here.
 *
 * The property under test throughout: **three answers that look alike are
 * not.** A calendar that is full, a calendar that did not reply, and no
 * calendar at all produce different next actions, and collapsing them is how
 * a system tells a client "nothing is free this week" because a token expired.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260911140000_a_slot_that_was_never_read.sql'));

const SOURCE = { provider: 'google', calendarId: 'primary' };
const NOW = '2026-09-12T08:00:00.000Z';

const slot = (startAt: string, minutes: number): Slot => ({
  startAt,
  endAt: new Date(Date.parse(startAt) + minutes * 60_000).toISOString(),
});

const readAnswer = (slots: readonly Slot[]): AvailabilityAnswer => ({
  state: 'read',
  source: SOURCE,
  readAt: NOW,
  slots,
});

const LOOSE = { durationMinutes: 30, minimumNoticeMinutes: 0, bufferMinutes: 0 };

// ═══════════════════════════════════════════════════════════════════════════
// A. Three answers that look alike
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a full calendar, a silent one, and no calendar are different answers', () => {
  test('a calendar that answered with nothing is a real answer', () => {
    // "Nothing is free that week" is something you can tell a lead. It is the
    // one of the three that permits a sentence about their week.
    const result = proposableSlots(readAnswer([]));

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true && result.slots, []);
  });

  test('a calendar that did not answer is not an answer, and says so', () => {
    const result = proposableSlots({ state: 'unreadable', source: SOURCE, reason: 'timeout' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unreadable');
  });

  test('no calendar at all is a third thing again', () => {
    const result = proposableSlots({ state: 'unconfigured' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unconfigured');
  });

  test('the two refusals are distinguishable, because they need different sentences', () => {
    // "Let me check and come back" vs "nothing is free that week" are not the
    // same message, and a caller that cannot tell them apart will send one of
    // them wrongly.
    const silent = proposableSlots({ state: 'unreadable', source: SOURCE, reason: 'timeout' });
    const absent = proposableSlots({ state: 'unconfigured' });

    assert.notEqual(
      silent.ok === false && silent.reason,
      absent.ok === false && absent.reason,
    );
  });
});

describe('B. the default source invents nothing', () => {
  test('with no provider chosen, the answer is unconfigured — not an empty calendar', () => {
    // BLK-005. Deliberately not a stub returning plausible slots: a fake
    // calendar is indistinguishable from a real one at every call site.
    assert.deepEqual(readAvailability(), { state: 'unconfigured' });
  });

  test('so nothing can be offered today, which is the refusal working', () => {
    const result = offerableSlots(readAvailability(), {}, LOOSE, NOW);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unconfigured');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Filtering narrows what was read, and can only ever shorten it
// ═══════════════════════════════════════════════════════════════════════════

describe('C. §5.1 local filters', () => {
  const candidates = [
    slot('2026-09-12T09:00:00.000Z', 60),
    slot('2026-09-12T11:00:00.000Z', 15),
    slot('2026-09-12T14:00:00.000Z', 30),
  ];

  test('a slot shorter than the meeting is not a candidate', () => {
    const kept = filterSlots(candidates, LOOSE, NOW);

    assert.equal(kept.length, 2);
    assert.ok(!kept.some((s) => s.startAt === '2026-09-12T11:00:00.000Z'));
  });

  test('minimum notice removes what nobody could prepare for', () => {
    // A lead asking at 09:58 for 10:00 is asking for something nobody can be
    // ready for. Two hours of notice drops the 09:00 slot.
    const kept = filterSlots(candidates, { ...LOOSE, minimumNoticeMinutes: 120 }, NOW);

    assert.ok(!kept.some((s) => s.startAt === '2026-09-12T09:00:00.000Z'));
    assert.ok(kept.some((s) => s.startAt === '2026-09-12T14:00:00.000Z'));
  });

  test('the buffer is needed on both sides, not one', () => {
    // 30-minute meeting + 15 either side = 60. Only the hour-long slot fits.
    const kept = filterSlots(candidates, { ...LOOSE, bufferMinutes: 15 }, NOW);

    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.startAt, '2026-09-12T09:00:00.000Z');
  });

  test('a malformed or inverted slot is dropped rather than trusted', () => {
    const bad: Slot[] = [
      { startAt: 'not-a-time', endAt: '2026-09-12T10:00:00.000Z' },
      { startAt: '2026-09-12T10:00:00.000Z', endAt: '2026-09-12T09:00:00.000Z' },
    ];

    assert.deepEqual(filterSlots(bad, LOOSE, NOW), []);
  });

  test('a clock that does not parse fails closed, not open', () => {
    // `start < NaN` is false for every start, so the first draft silently
    // disabled minimum notice whenever `now` was garbage — the one constraint
    // whose absence a lead cannot see. Found by review.
    assert.deepEqual(filterSlots(candidates, { ...LOOSE, minimumNoticeMinutes: 120 }, 'not-a-clock'), []);
    assert.deepEqual(filterSlots(candidates, LOOSE, ''), []);
  });

  test('filtering never adds a slot that was not read', () => {
    // The property that matters: this narrows, and narrowing cannot invent.
    for (const constraints of [LOOSE, { ...LOOSE, bufferMinutes: 15 }, { ...LOOSE, minimumNoticeMinutes: 600 }]) {
      const kept = filterSlots(candidates, constraints, NOW);
      assert.ok(kept.length <= candidates.length);
      for (const s of kept) assert.ok(candidates.includes(s));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Ranking puts the lead's constraint before the agency's convenience
// ═══════════════════════════════════════════════════════════════════════════

describe('D. §5.2 ranking', () => {
  const exact = slot('2026-09-14T15:00:00.000Z', 60);
  const sameDayLater = slot('2026-09-14T17:00:00.000Z', 60);
  const otherDayEarlier = slot('2026-09-13T09:00:00.000Z', 60);

  test('the exact requested slot comes first when it is genuinely available', () => {
    const ranked = rankSlots([otherDayEarlier, sameDayLater, exact], {
      requestedStartAt: '2026-09-14T15:00:00.000Z',
    });

    assert.equal(ranked[0]?.startAt, exact.startAt);
  });

  test('a slot inside a requested range outranks one merely on the same day', () => {
    // "6–8 PM" is a constraint; 5 PM on the same day is not inside it.
    const inWindow = slot('2026-09-14T18:30:00.000Z', 60);
    const ranked = rankSlots([sameDayLater, inWindow], {
      requestedStartAt: '2026-09-14T18:00:00.000Z',
      requestedWindowEnd: '2026-09-14T20:00:00.000Z',
    });

    assert.equal(ranked[0]?.startAt, inWindow.startAt);
  });

  test('the requested day beats an earlier slot on another day', () => {
    // Earlier is the agency's convenience; the day they asked for is theirs.
    const ranked = rankSlots([otherDayEarlier, sameDayLater], {
      requestedStartAt: '2026-09-14T15:00:00.000Z',
    });

    assert.equal(ranked[0]?.startAt, sameDayLater.startAt);
  });

  test('with no request at all, the earliest comes first', () => {
    const ranked = rankSlots([sameDayLater, otherDayEarlier], {});

    assert.equal(ranked[0]?.startAt, otherDayEarlier.startAt);
  });

  test('ranking is stable and does not reshuffle equal candidates', () => {
    const input = [sameDayLater, otherDayEarlier, exact];
    const once = rankSlots(input, { requestedStartAt: '2026-09-14T15:00:00.000Z' });
    const twice = rankSlots(input, { requestedStartAt: '2026-09-14T15:00:00.000Z' });

    assert.deepEqual(once, twice);
  });

  test('ranking reorders and never adds or drops', () => {
    const input = [sameDayLater, otherDayEarlier, exact];
    const ranked = rankSlots(input, { requestedStartAt: '2026-09-14T15:00:00.000Z' });

    assert.equal(ranked.length, input.length);
    for (const s of input) assert.ok(ranked.includes(s));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. The one door
// ═══════════════════════════════════════════════════════════════════════════

describe('E. a caller cannot reach the slots without passing the refusal', () => {
  test('the pipeline filters, ranks and caps in one call', () => {
    const answer = readAnswer([
      slot('2026-09-14T17:00:00.000Z', 60),
      slot('2026-09-13T09:00:00.000Z', 60),
      slot('2026-09-14T15:00:00.000Z', 60),
      slot('2026-09-15T09:00:00.000Z', 60),
    ]);
    const result = offerableSlots(answer, { requestedStartAt: '2026-09-14T15:00:00.000Z' }, LOOSE, NOW);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.slots.length, 3, '§6.1 — three is the cap');
    assert.equal(result.ok === true && result.slots[0]?.startAt, '2026-09-14T15:00:00.000Z');
  });

  test('the cap is the caller’s, and the default is three', () => {
    const answer = readAnswer([
      slot('2026-09-13T09:00:00.000Z', 60),
      slot('2026-09-14T09:00:00.000Z', 60),
      slot('2026-09-15T09:00:00.000Z', 60),
      slot('2026-09-16T09:00:00.000Z', 60),
      slot('2026-09-17T09:00:00.000Z', 60),
    ]);
    const byDefault = offerableSlots(answer, {}, LOOSE, NOW);
    const one = offerableSlots(answer, {}, LOOSE, NOW, 1);
    const all = offerableSlots(answer, {}, LOOSE, NOW, 10);
    const none = offerableSlots(answer, {}, LOOSE, NOW, 0);

    assert.equal(byDefault.ok === true && byDefault.slots.length, 3);
    assert.equal(one.ok === true && one.slots.length, 1);
    assert.equal(all.ok === true && all.slots.length, 5, 'a cap above the count returns everything read');
    assert.deepEqual(none.ok === true && none.slots, [], 'a cap of zero offers nothing and still succeeds');
  });

  test('a full calendar offers nothing, and still succeeds', () => {
    // The difference that matters downstream: ok, with an empty list, is
    // "nothing is free" — a sentence about their week, not about our system.
    const result = offerableSlots(readAnswer([]), {}, LOOSE, NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true && result.slots, []);
  });

  test('an unreadable calendar offers nothing, and does not succeed', () => {
    const result = offerableSlots(
      { state: 'unreadable', source: SOURCE, reason: 'timeout' }, {}, LOOSE, NOW,
    );

    assert.equal(result.ok, false);
  });

  test('everything offered was read — the subset property, over the whole pipeline', () => {
    // The one rule §5 actually turns on. Whatever the request or constraints,
    // every slot that comes out went in.
    const slots = [
      slot('2026-09-14T15:00:00.000Z', 60),
      slot('2026-09-14T17:00:00.000Z', 60),
      slot('2026-09-13T09:00:00.000Z', 90),
    ];
    for (const request of [{}, { requestedStartAt: '2026-09-14T15:00:00.000Z' }, { requestedStartAt: '2026-09-01T10:00:00.000Z' }]) {
      const result = offerableSlots(readAnswer(slots), request, LOOSE, NOW);
      assert.equal(result.ok, true);
      for (const s of result.ok === true ? result.slots : []) {
        assert.ok(slots.includes(s), `${s.startAt} was offered and never read`);
      }
    }
  });

  test('the source and the moment ride along, so a proposal can prove it asked', () => {
    const result = offerableSlots(readAnswer([slot('2026-09-14T15:00:00.000Z', 60)]), {}, LOOSE, NOW);

    assert.equal(result.ok === true && result.source.provider, 'google');
    assert.equal(result.ok === true && result.readAt, NOW);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. The row's floor
// ═══════════════════════════════════════════════════════════════════════════

describe('F. a proposal that recorded no answer is refused at the row', () => {
  test('proposed and booked both require a source and a moment', () => {
    assert.match(SQL, /constraint meetings_proposal_was_read check/);
    assert.match(SQL, /status not in \('proposed', 'booked'\)/);
    assert.match(SQL, /availability_source is not null and availability_read_at is not null/);
  });

  test('it binds new and changed rows rather than backfilling a judgement', () => {
    // G-225 shipped hours earlier; rows written between the two predate the
    // rule. The same choice opportunities_lost_says_why made (ADM-76).
    assert.match(SQL, /\) not valid;/);
  });

  test('the moment is stored, not merely required — G-227 compares against it', () => {
    // §5.1 ends with "Re-check availability immediately before committing the
    // booking". That re-check is G-227's, and this is the timestamp it will
    // measure staleness from, which is why the column exists rather than the
    // constraint simply demanding a non-null flag.
    assert.match(SQL, /availability_read_at timestamptz/);
    assert.match(SQL, /meetings_availability_age_idx/);
    assert.match(SQL, /on crm\.meetings \(organization_id, availability_read_at\)/);
  });
});
