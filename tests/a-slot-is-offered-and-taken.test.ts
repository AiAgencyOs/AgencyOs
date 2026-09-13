import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';
import { interpretBook, interpretPropose } from '../src/lib/scheduler/meeting-commands-eval.ts';
import { bufferedSlot, offerableSlots, proposalWindow, sliceWindows, slotStillFree } from '../src/lib/scheduling/availability.ts';
import { offeredSlots } from '../src/modules/crm/meetings-view.ts';

/**
 * A slot is offered, and taken — G-243, Scheduler §5 and §6.
 *
 * The doors are driven live by verify-slot-offer.mjs; the Google half by
 * the stand-in in the-calendar-is-read-not-invented. What is executed here
 * is the pure middle: a free window cut into offerable times, the re-check
 * as a question about a fresh read, the offer as a person sees it — and,
 * read from source, the ORDER the booking library keeps: re-check, note it,
 * the provider event, the row, and the event taken back when the row refuses.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const migration = sqlCode(read('supabase/migrations/20260913140000_a_slot_is_offered_and_taken.sql'));
const BOOKING = codeOnly(read('src/lib/scheduling/booking.ts'));

describe('A. a free window is cut into offerable times, never past its edge', () => {
  test('slots start on the step boundary at or after the window start and end inside it', () => {
    const slots = sliceWindows([{ startAt: '2026-09-15T09:10:00.000Z', endAt: '2026-09-15T10:45:00.000Z' }], 30);
    assert.deepEqual(slots.map((s) => s.startAt), ['2026-09-15T09:30:00.000Z', '2026-09-15T10:00:00.000Z']);
    assert.equal(slots[1]!.endAt, '2026-09-15T10:30:00.000Z');
    assert.deepEqual(sliceWindows([{ startAt: '2026-09-15T09:00:00.000Z', endAt: '2026-09-15T09:20:00.000Z' }], 30), [], 'a window shorter than the meeting offers nothing');
    assert.deepEqual(sliceWindows([{ startAt: 'garbage', endAt: 'x' }], 30), []);
    assert.deepEqual(sliceWindows([{ startAt: '2026-09-15T09:00:00.000Z', endAt: '2026-09-15T10:00:00.000Z' }], 0), []);
  });

  test('the buffer is kept INSIDE the window while cutting, and a free week with the production constraints offers three slots', () => {
    // 09:00–10:30 with a 15-minute buffer: a 30-minute meeting fits at 09:30 only (09:15 is not on the step; 10:00 would need free time to 10:45).
    const cut = sliceWindows([{ startAt: '2026-09-15T09:00:00.000Z', endAt: '2026-09-15T10:30:00.000Z' }], 30, 30, 15);
    assert.deepEqual(cut.map((s) => s.startAt), ['2026-09-15T09:30:00.000Z']);
    assert.equal(cut[0]!.endAt, '2026-09-15T10:00:00.000Z', 'the slot itself stays the meeting’s length');
    // What the first production proposal saw: one free window over seven days, the constraints booking.ts uses.
    const week = { state: 'read' as const, source: { provider: 'google', calendarId: 'c' }, readAt: '2026-09-13T16:00:00.000Z', slots: [{ startAt: '2026-09-13T16:00:00.000Z', endAt: '2026-09-20T16:00:00.000Z' }] };
    const offer = offerableSlots(
      { ...week, slots: sliceWindows(week.slots, 30, 30, 15) },
      {},
      { durationMinutes: 30, minimumNoticeMinutes: 60, bufferMinutes: 0 },
      '2026-09-13T16:00:00.000Z',
    );
    assert.ok(offer.ok && offer.slots.length === 3, 'a free week offers three, not nothing');
    // And the way it was: cut to the duration, then filtered for duration plus two buffers — nothing survives. Pinned so nobody rebuilds it.
    const asItWas = offerableSlots({ ...week, slots: sliceWindows(week.slots, 30) }, {}, { durationMinutes: 30, minimumNoticeMinutes: 60, bufferMinutes: 15 }, '2026-09-13T16:00:00.000Z');
    assert.ok(asItWas.ok && asItWas.slots.length === 0, 'the shape that offered nothing');
    assert.match(BOOKING, /sliceWindows\(answer\.slots, parsed\.data\.duration, 30, CONSTRAINTS\.bufferMinutes\)/);
    assert.match(BOOKING, /minimumNoticeMinutes: CONSTRAINTS\.minimumNoticeMinutes, bufferMinutes: 0/);
  });

  test('then §5’s filters and ranking apply to the times, so the offer is three at most and the requested time first', () => {
    const read = { state: 'read' as const, source: { provider: 'google', calendarId: 'c' }, readAt: '2026-09-15T08:00:00.000Z', slots: sliceWindows([{ startAt: '2026-09-15T09:00:00.000Z', endAt: '2026-09-15T13:00:00.000Z' }], 30) };
    const offer = offerableSlots(read, { requestedStartAt: '2026-09-15T11:00:00.000Z' }, { durationMinutes: 30, minimumNoticeMinutes: 60, bufferMinutes: 0 }, '2026-09-15T08:00:00.000Z');
    assert.ok(offer.ok);
    if (!offer.ok) return;
    assert.equal(offer.slots.length, 3);
    assert.equal(offer.slots[0]!.startAt, '2026-09-15T11:00:00.000Z', 'the exact requested time first (§5.2)');
  });
});

describe('A2. the window a proposal reads', () => {
  test('the day around what the lead named; the next seven days when they named nothing — or named a moment already gone', () => {
    assert.deepEqual(proposalWindow('2026-09-10T08:00:00.000Z', { requestedStartAt: '2026-09-15T15:00:00.000Z' }), { from: '2026-09-14T15:00:00.000Z', to: '2026-09-16T15:00:00.000Z', fellBack: false });
    assert.deepEqual(proposalWindow('2026-09-10T08:00:00.000Z', { requestedStartAt: '2026-09-15T15:00:00.000Z', requestedWindowEnd: '2026-09-15T18:00:00.000Z' }).to, '2026-09-16T18:00:00.000Z');
    assert.deepEqual(proposalWindow('2026-09-10T08:00:00.000Z', {}), { from: '2026-09-10T08:00:00.000Z', to: '2026-09-17T08:00:00.000Z', fellBack: false });
    // Review: a request in the past produced a window that ended before it began, and a false "did not answer".
    const past = proposalWindow('2026-09-17T08:00:00.000Z', { requestedStartAt: '2026-09-15T15:00:00.000Z' });
    assert.deepEqual(past, { from: '2026-09-17T08:00:00.000Z', to: '2026-09-24T08:00:00.000Z', fellBack: true });
    assert.ok(Date.parse(past.to) > Date.parse(past.from));
  });
  test('the re-check asks about the slot with its buffer', () => {
    assert.deepEqual(bufferedSlot({ startAt: '2026-09-15T10:00:00.000Z', endAt: '2026-09-15T10:30:00.000Z' }, 15), { startAt: '2026-09-15T09:45:00.000Z', endAt: '2026-09-15T10:45:00.000Z' });
  });
});

describe('B. the re-check is a question about a fresh read', () => {
  const slot = { startAt: '2026-09-15T11:00:00.000Z', endAt: '2026-09-15T11:30:00.000Z' };
  test('free only when wholly inside a window the calendar has free now', () => {
    const read = (windows: { startAt: string; endAt: string }[]) => ({ state: 'read' as const, source: { provider: 'google', calendarId: 'c' }, readAt: '2026-09-15T10:59:00.000Z', slots: windows });
    assert.deepEqual(slotStillFree(read([{ startAt: '2026-09-15T10:00:00.000Z', endAt: '2026-09-15T12:00:00.000Z' }]), slot), { free: true });
    assert.deepEqual(slotStillFree(read([{ startAt: '2026-09-15T11:00:00.000Z', endAt: '2026-09-15T11:30:00.000Z' }]), slot), { free: true }, 'exactly the slot is still inside');
    assert.deepEqual(slotStillFree(read([{ startAt: '2026-09-15T11:10:00.000Z', endAt: '2026-09-15T12:00:00.000Z' }]), slot), { free: false, reason: 'taken' }, 'a busy edge inside the slot is taken');
    assert.deepEqual(slotStillFree(read([]), slot), { free: false, reason: 'taken' });
  });
  test('a calendar that did not answer is not an answer — unreadable and unconfigured both refuse', () => {
    assert.deepEqual(slotStillFree({ state: 'unreadable', source: { provider: 'google', calendarId: 'c' }, reason: 'x' }, slot), { free: false, reason: 'unreadable' });
    assert.deepEqual(slotStillFree({ state: 'unconfigured' }, slot), { free: false, reason: 'unconfigured' });
  });
});

describe('C. the offer as a person sees it', () => {
  test('in the meeting’s zone with the agency’s beside it; malformed entries dropped', () => {
    const rows = offeredSlots(
      { timezone: 'Europe/London', proposed_slots: [{ startAt: '2026-09-15T11:00:00.000Z', endAt: '2026-09-15T11:30:00.000Z' }, { nope: 1 }, 'x'] },
      'Asia/Kolkata',
      (iso, zone) => `${iso.slice(11, 16)}@${zone}`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.label, '11:00@Europe/London – 11:30@Europe/London Europe/London (= 11:00@Asia/Kolkata Asia/Kolkata)');
    // Review ran the real formatter: "4:30 pm".slice(-5) was "30 pm". The end is a clock.
    const real = offeredSlots({ timezone: 'Asia/Kolkata', proposed_slots: [{ startAt: '2026-09-15T11:00:00.000Z', endAt: '2026-09-15T11:30:00.000Z' }] }, 'Asia/Kolkata', () => '15 Sept 2026, 4:30 pm', () => '5:00 pm');
    assert.equal(real[0]!.label, '15 Sept 2026, 4:30 pm – 5:00 pm Asia/Kolkata');
    assert.deepEqual(offeredSlots({ timezone: null, proposed_slots: null }, 'Asia/Kolkata', () => ''), []);
  });
});

describe('D. the sentences', () => {
  test('a full calendar is a refusal that names the next action; booked says the link, or that there is none', () => {
    assert.match((interpretPropose('nothing_to_offer', 0) as { message: string }).message, /nothing free .* Widen the window/);
    assert.match((interpretPropose('proposed', 2) as { message: string }).message, /^2 slots proposed/);
    assert.match((interpretBook('booked', 'https://meet.google.com/x') as { message: string }).message, /Meet link: https:\/\/meet\.google\.com\/x/);
    assert.match((interpretBook('booked', null) as { message: string }).message, /no Meet link/);
    assert.equal(interpretBook('stale_availability', null).kind, 'error');
  });
});

describe('E. the order the booking library keeps (read from source)', () => {
  test('re-check → note it → the provider event → the row; a refused row takes the event back; a video meeting without a link is not kept', () => {
    const recheck = BOOKING.indexOf('slotStillFree(recheck, padded)');
    const noted = BOOKING.indexOf("rpc('note_availability_read'");
    const event = BOOKING.indexOf('calendar.createEvent(');
    const row = BOOKING.indexOf("rpc('book_meeting'");
    assert.ok(recheck > 0 && recheck < noted && noted < event && event < row, 're-check, note, event, row');
    assert.match(BOOKING, /if \(parsed\.data\.mode === 'video_meeting' && event\.meet !== 'created' && event\.meet !== 'unavailable'\) \{\s*[\s\S]*?await calendar\.cancelEvent\(event\.eventId\);/);
    assert.match(BOOKING, /send the client your own video link/, 'on a shared Gmail calendar the booking stands and the sentence says who sends the link');
    const refused = BOOKING.indexOf("if (outcome !== 'booked' && outcome !== 'already_booked')");
    assert.ok(refused > row && BOOKING.indexOf('calendar.cancelEvent(event.eventId)', refused) > refused, 'a refused row cancels the event it created');
    assert.match(BOOKING, /const chosen = offered\.find\(/, 'only a slot that was offered can be booked');
    assert.ok(BOOKING.indexOf('minimumNoticeMinutes * 60_000') < recheck, 'the clock is re-asked before the calendar: a slot that has passed is refused');
    assert.match(BOOKING, /bufferedSlot\(chosen, CONSTRAINTS\.bufferMinutes\)/, 'the re-check carries the buffer the offer was filtered for');
    assert.match(BOOKING, /if \(outcome === 'already_booked'\) \{[\s\S]*?cancelEvent\(event\.eventId\)/, 'a race that lost takes its own event back');
    assert.doesNotMatch(BOOKING, /p_meeting_url: event\.htmlLink/, 'the agency’s event page is not a meeting link');
    assert.match(BOOKING, /await getAgencyTimeZone\(\)/, 'the zone falls back to the agency’s, never a constant');
    assert.match(BOOKING, /bookingKey = `meeting:\$\{parsed\.data\.id\}:\$\{new Date\(chosen\.startAt\)\.toISOString\(\)\}`/, 'the booking key is the meeting and the slot');
  });
});

describe('F. what the migration holds', () => {
  test('the offer is a bounded list at the row, and both doors demand can_write and a read behind the offer', () => {
    assert.match(migration, /jsonb_array_length\(proposed_slots\) between 1 and 3/);
    assert.equal((migration.match(/core\.can_write\(\)/g) ?? []).length, 2);
    assert.match(migration, /'nothing_to_offer'::text/);
    assert.match(migration, /p_availability_read_at > clock_timestamp\(\) \+ interval '1 minute'/, 'a moment from the future is not a read');
  });
});
