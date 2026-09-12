import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  analysisState,
  availabilityState,
  meetingControls,
  bookedOverlaps,
  completionState,
  evidenceTone,
  groupByDay,
  isKnownZone,
  meetingWindow,
  pickNewest,
  providerState,
  reminderState,
  startOfDayIn,
  timezonePair,
  whenOf,
  type JobLike,
  type MeetingLike,
} from '../src/modules/crm/meetings-view.ts';
import { MEETING_EVIDENCE_VISIBILITIES } from '../src/modules/crm/schema.ts';
import { MEETING_STATUSES, MEETING_TRANSITIONS, TERMINAL_MEETING_STATUSES } from '../src/modules/crm/schema.ts';

/**
 * A meeting worth showing — G-234, admin screens A08 (calendar) and A09
 * (meeting detail).
 *
 * The screens are read-only and every sentence they say about a meeting is
 * decided by meetings-view.ts, so this file EXECUTES those decisions rather
 * than reading a page. What a screen must never say (a completion inferred
 * from the clock, a reminder implied sent, a provider event that was never
 * written) is asserted as a positive: the sentence it says instead.
 */

const NOW = new Date('2026-09-12T10:00:00.000Z');

function meeting(over: Partial<MeetingLike> = {}): MeetingLike {
  return {
    id: over.id ?? 'm-1',
    status: 'booked',
    requested_mode: 'call',
    booked_mode: 'call',
    requested_start_at: '2026-09-13T09:00:00.000Z',
    requested_window_end: null,
    confirmed_start_at: '2026-09-13T09:30:00.000Z',
    confirmed_end_at: '2026-09-13T10:00:00.000Z',
    timezone: 'Asia/Kolkata',
    provider: null,
    provider_event_id: null,
    meeting_url: null,
    availability_source: null,
    availability_read_at: null,
    booked_at: '2026-09-12T08:00:00.000Z',
    cancelled_at: null,
    cancellation_reason: null,
    completed_at: null,
    completed_by: null,
    outcome: null,
    supersedes_id: null,
    ...over,
  };
}
const job = (over: Partial<JobLike> = {}): JobLike => ({ status: 'queued', run_at: '2026-09-13T09:20:00.000Z', attempts: 0, last_error: null, created_at: '2026-09-12T08:00:00.000Z', ...over });

const ZONE = 'Asia/Kolkata';

describe('A. the window is the agency’s calendar day, bounded, and named honestly', () => {
  test('midnight in the agency’s zone is the instant it really is', () => {
    // 10:00Z on the 12th is 15:30 IST on the 12th; IST midnight that day is 18:30Z on the 11th.
    assert.equal(startOfDayIn(ZONE, NOW).toISOString(), '2026-09-11T18:30:00.000Z');
    // And in a zone west of UTC the same instant is still the 12th's morning: midnight is 04:00Z.
    assert.equal(startOfDayIn('America/New_York', NOW).toISOString(), '2026-09-12T04:00:00.000Z');
    assert.equal(startOfDayIn('UTC', NOW).toISOString(), '2026-09-12T00:00:00.000Z');
  });

  test('the default is the next seven agency days, from today’s midnight — so a meeting that began an hour ago is in it', () => {
    const w = meetingWindow(undefined, NOW, ZONE);
    assert.equal(w.key, 'week');
    assert.equal(w.from.toISOString(), '2026-09-11T18:30:00.000Z');
    assert.equal(w.to.getTime() - w.from.getTime(), 7 * 86_400_000);
    assert.ok(w.from.getTime() < NOW.getTime(), 'today’s earlier hours are inside the window');
    assert.match(w.label, /next 7 days from today \(Asia\/Kolkata\)/);
  });

  test('every key is a window that ends after it starts, chips say what they are, and a stranger falls back to the default', () => {
    for (const key of ['today', 'week', 'month', 'past']) {
      const w = meetingWindow(key, NOW, ZONE);
      assert.equal(w.key, key);
      assert.ok(w.to.getTime() > w.from.getTime(), `${key} is empty`);
    }
    assert.equal(meetingWindow('today', NOW, ZONE).chip, 'Today');
    assert.equal(meetingWindow('past', NOW, ZONE).chip, 'Last 30 days');
    assert.equal(meetingWindow('calendar-grid', NOW, ZONE).key, 'week');
    assert.equal(meetingWindow('past', NOW, ZONE).to.toISOString(), '2026-09-11T18:30:00.000Z', 'the past ends at today’s midnight');
    assert.equal(meetingWindow('today', NOW, ZONE).to.getTime() - meetingWindow('today', NOW, ZONE).from.getTime(), 86_400_000);
  });
});

describe('B. requested and agreed times stay apart', () => {
  test('an agreed time wins, and says it is agreed', () => {
    const w = whenOf(meeting());
    assert.equal(w.kind, 'confirmed');
    assert.equal(w.kind === 'confirmed' && w.start, '2026-09-13T09:30:00.000Z');
  });

  test('with nothing agreed, the request is shown — as a request', () => {
    const w = whenOf(meeting({ confirmed_start_at: null, confirmed_end_at: null, status: 'requested' }));
    assert.equal(w.kind, 'requested');
    assert.equal(w.kind === 'requested' && w.start, '2026-09-13T09:00:00.000Z');
  });

  test('and with neither, it is unscheduled rather than placed somewhere', () => {
    assert.equal(whenOf(meeting({ confirmed_start_at: null, requested_start_at: null })).kind, 'unscheduled');
  });

  test('cards group by the day the caller computes, in time order, timeless ones last', () => {
    const rows = [
      meeting({ id: 'late', confirmed_start_at: '2026-09-14T15:00:00.000Z', confirmed_end_at: '2026-09-14T16:00:00.000Z' }),
      meeting({ id: 'none', confirmed_start_at: null, requested_start_at: null, status: 'requested' }),
      meeting({ id: 'early', confirmed_start_at: '2026-09-13T06:00:00.000Z', confirmed_end_at: '2026-09-13T07:00:00.000Z' }),
      meeting({ id: 'mid' }),
    ];
    const groups = groupByDay(rows, (iso) => iso.slice(0, 10));
    assert.deepEqual(groups.map((g) => g.day), ['2026-09-13', '2026-09-14', null]);
    assert.deepEqual(groups[0]!.rows.map((r) => r.id), ['early', 'mid']);
    assert.deepEqual(groups[2]!.rows.map((r) => r.id), ['none']);
  });
});

describe('C. conflicts are AgencyOS bookings that overlap, and nothing else', () => {
  test('two booked meetings that overlap name each other', () => {
    const a = meeting({ id: 'a' });
    const b = meeting({ id: 'b', confirmed_start_at: '2026-09-13T09:45:00.000Z', confirmed_end_at: '2026-09-13T10:15:00.000Z' });
    const c = bookedOverlaps([a, b]);
    assert.deepEqual(c.get('a'), ['b']);
    assert.deepEqual(c.get('b'), ['a']);
  });

  test('a meeting that ends exactly when the next starts does not conflict', () => {
    const a = meeting({ id: 'a' });
    const b = meeting({ id: 'b', confirmed_start_at: '2026-09-13T10:00:00.000Z', confirmed_end_at: '2026-09-13T10:30:00.000Z' });
    assert.equal(bookedOverlaps([a, b]).size, 0);
  });

  test('only booked rows count — a cancelled twin of the same slot is not a conflict', () => {
    const a = meeting({ id: 'a' });
    const b = meeting({ id: 'b', status: 'cancelled' });
    const c = meeting({ id: 'c', status: 'requested', confirmed_start_at: null, confirmed_end_at: null });
    assert.equal(bookedOverlaps([a, b, c]).size, 0);
  });

  test('a booking with no end cannot overlap anything — it is not guessed', () => {
    assert.equal(bookedOverlaps([meeting({ id: 'a' }), meeting({ id: 'b', confirmed_end_at: null })]).size, 0);
  });
});

describe('D. what is said about a reminder', () => {
  test('a booked meeting with a queued job: queued, and no sender exists', () => {
    const said = reminderState(job(), meeting());
    assert.match(said.text, /Queued for 2026-09-13T09:20/);
    assert.match(said.text, /no sender is registered/);
    assert.equal(said.tone, 'warning');
  });

  test('a meeting that is not booked has no reminder, and that is not an absence', () => {
    for (const status of ['requested', 'proposed', 'cancelled', 'completed', 'no_show']) {
      const said = reminderState(job(), meeting({ status }));
      assert.match(said.text, /No reminder — the meeting is/, status);
      assert.equal(said.tone, 'neutral');
    }
  });

  test('no job on a booked meeting says so plainly; a dead job says why', () => {
    assert.match(reminderState(null, meeting()).text, /No reminder is scheduled/);
    const dead = reminderState(job({ status: 'dead', attempts: 3, last_error: 'no sender' }), meeting());
    assert.match(dead.text, /parked after 3 attempts: no sender/);
    assert.equal(dead.tone, 'danger');
    assert.match(reminderState(job({ status: 'failed', attempts: 1 }), meeting()).text, /failed after 1 attempt\./);
  });

  test('every other job status is said as itself, never as sent', () => {
    assert.equal(reminderState(job({ status: 'running' }), meeting()).tone, 'info');
    assert.match(reminderState(job({ status: 'succeeded' }), meeting()).text, /The reminder job ran/);
    assert.match(reminderState(job({ status: 'cancelled' }), meeting()).text, /Reminder job is cancelled/);
  });

  test('the calendar and the detail page pick the same job: the newest', () => {
    const older = job({ created_at: '2026-09-12T07:00:00.000Z', status: 'dead' });
    const newer = job({ created_at: '2026-09-12T08:00:00.000Z', status: 'queued' });
    assert.equal(pickNewest([older, newer]), newer);
    assert.equal(pickNewest([newer, older]), newer, 'whatever the order they arrive in');
    assert.equal(pickNewest([]), null);
  });
});

describe('E. what is said about analysis', () => {
  test('a meeting that is not completed cannot have analysis requested — and only a person completes it', () => {
    assert.match(analysisState(null, meeting(), 2).text, /not marked completed .*only a person/);
  });

  test('a completed meeting with no evidence names the empty room', () => {
    assert.match(analysisState(null, meeting({ status: 'completed' }), 0).text, /no evidence .*empty room/);
  });

  test('completed with evidence and no request: not requested; queued: the runner takes it (G-239); succeeded: proposed, not confirmed', () => {
    assert.equal(analysisState(null, meeting({ status: 'completed' }), 1).text, 'Not requested.');
    const q = analysisState(job(), meeting({ status: 'completed' }), 1);
    // G-229 said "no handler can run it until an AI provider is chosen (BLK-001)"; G-239 built the handler.
    assert.match(q.text, /queued — the runner takes it on its next tick/);
    assert.doesNotMatch(q.text, /BLK-001/);
    assert.equal(q.tone, 'info');
    const done = analysisState(job({ status: 'succeeded' }), meeting({ status: 'completed' }), 1);
    assert.match(done.text, /proposed summary is filed below .* Nothing in it is confirmed until a person confirms it/);
    assert.equal(done.tone, 'success');
  });

  test('a failed or parked analysis job says so; a running one is information', () => {
    assert.match(analysisState(job({ status: 'failed', last_error: 'no provider' }), meeting({ status: 'completed' }), 1).text, /failed: no provider/);
    assert.match(analysisState(job({ status: 'dead' }), meeting({ status: 'completed' }), 1).text, /was parked\./);
    assert.equal(analysisState(job({ status: 'running' }), meeting({ status: 'completed' }), 1).tone, 'info');
  });
});

describe('F. completion comes from the row, never the clock', () => {
  test('a booked meeting whose end time has passed is still booked, and says time passing is not completion', () => {
    const past = meeting({ confirmed_end_at: '2026-09-12T09:00:00.000Z' });
    const said = completionState(past, NOW);
    assert.match(said.text, /^Booked — the end time has passed/);
    assert.match(said.text, /Time passing is not completion/);
    assert.doesNotMatch(said.text, /^Completed/);
  });

  test('a completed meeting shows its outcome and who marked it', () => {
    const said = completionState(meeting({ status: 'completed', outcome: 'requirements_confirmed', completed_at: '2026-09-13T10:05:00.000Z', completed_by: '11111111-2222-3333-4444-555555555555' }), NOW);
    assert.match(said.text, /^Completed — requirements confirmed at 2026-09-13T10:05/);
    assert.match(said.text, /by 11111111/);
    assert.equal(said.tone, 'success');
  });

  test('a no-show is a no-show, not a completion; a cancelled meeting did not happen; a request is not completed', () => {
    assert.match(completionState(meeting({ status: 'no_show' }), NOW).text, /no-show/);
    assert.match(completionState(meeting({ status: 'cancelled' }), NOW).text, /^Cancelled — nothing happened/);
    assert.match(completionState(meeting({ status: 'requested', confirmed_end_at: null }), NOW).text, /Not completed — the meeting is requested/);
    // A booked meeting still ahead is simply not completed, not warned about.
    assert.equal(completionState(meeting(), NOW).tone, 'neutral');
  });
});

describe('G. provider and availability are facts, or named as absent', () => {
  test('no provider is the deployment with no calendar, by name', () => {
    const said = providerState(meeting());
    assert.match(said.text, /BLK-005/);
    assert.match(said.text, /nothing was written to an external calendar/);
  });

  test('a provider without an event id is a warning, not a booking', () => {
    const said = providerState(meeting({ provider: 'google' }));
    assert.match(said.text, /no event id recorded/);
    assert.equal(said.tone, 'warning');
    assert.equal(providerState(meeting({ provider: 'google', provider_event_id: 'evt_1' })).tone, 'success');
  });

  test('availability is a key that says where the offer came from, or that none was read', () => {
    assert.match(availabilityState(meeting()).text, /No availability was read/);
    assert.match(availabilityState(meeting({ availability_source: 'google:cal-1', availability_read_at: '2026-09-12T07:59:00.000Z' })).text, /read from google:cal-1 at 2026-09-12T07:59/);
  });
});

describe('H. every control is rendered, and says whether it is a command or what it is blocked on — truthfully', () => {
  test('a booked meeting: reschedule blocked on BLK-005; cancel, complete and no-show are commands naming their doors; evidence is a command for typed text', () => {
    // G-234 rendered these four BLOCKED on "no command exists yet"; G-237 built the commands.
    const controls = meetingControls('booked');
    const reschedule = controls.find((c) => c.action === 'Reschedule');
    assert.ok(reschedule, 'reschedule is offered');
    assert.equal(reschedule!.state, 'blocked');
    assert.match(reschedule!.reason, /BLK-005/, 'reschedule names the missing calendar');
    assert.match(reschedule!.reason, /crm\.book_meeting exists/, 'and does not claim the booking command is missing');
    assert.doesNotMatch(reschedule!.reason, /no command exists/);
    for (const [target, door] of [['cancelled', 'crm.cancel_meeting'], ['completed', 'crm.complete_meeting'], ['no_show', 'crm.record_no_show']] as const) {
      const c = controls.find((x) => x.target === target);
      assert.ok(c, `${target} has a control`);
      assert.equal(c!.state, 'command');
      assert.equal(c!.door, door);
      assert.doesNotMatch(c!.reason, /no command exists/);
    }
    const evidence = controls.find((c) => c.door === 'crm.add_meeting_evidence');
    assert.equal(evidence!.state, 'command');
    assert.match(evidence!.reason, /no artifact store is chosen/, 'a file still cannot be attached, and it says why');
    assert.ok(controls.every((c) => c.owner.length > 0), 'every control names an owner (Blueprint §8)');
    assert.ok(!controls.some((c) => c.door === 'crm.request_meeting_analysis'), 'analysis is not offered before completion — the gate would refuse it');
  });

  test('a requested or proposed meeting: booking is blocked on the calendar, not on a command that exists; cancel is a command', () => {
    // Review caught the first draft telling the operator crm.book_meeting did not exist.
    for (const status of ['requested', 'proposed'] as const) {
      const book = meetingControls(status).find((c) => c.target === 'booked');
      assert.ok(book, `${status} offers a booking control`);
      assert.equal(book!.state, 'blocked');
      assert.match(book!.reason, /crm\.book_meeting exists but cannot be offered a slot/);
      assert.doesNotMatch(book!.reason, /no command exists/);
      assert.match(book!.owner, /calendar provider/);
      assert.equal(meetingControls(status).find((c) => c.target === 'cancelled')?.state, 'command');
    }
    assert.equal(meetingControls('requested').find((c) => c.target === 'proposed')?.action, 'Propose a time');
  });

  test('the controls are the state machine: every legal transition of every open status has one, and no control offers an illegal one', () => {
    for (const status of MEETING_STATUSES) {
      const controls = meetingControls(status);
      const moves = controls.filter((c) => c.target !== null);
      if ((TERMINAL_MEETING_STATUSES as readonly string[]).includes(status)) {
        assert.equal(moves.length, 0, `${status} is settled and offers no move`);
        continue;
      }
      for (const target of MEETING_TRANSITIONS[status]) {
        assert.ok(moves.some((c) => c.target === target), `${status} → ${target} has no control`);
      }
      for (const c of moves) {
        if (c.target !== status) assert.ok(MEETING_TRANSITIONS[status].includes(c.target!), `${status} offers ${c.target}, which the row refuses`);
      }
    }
  });

  test('a settled meeting still takes evidence, and a completed one may ask the analysis gate again', () => {
    // Review: the first draft returned [] for every settled status, so a
    // completion with no note could never reach §9.3's chain from the page.
    for (const status of TERMINAL_MEETING_STATUSES) {
      const evidence = meetingControls(status).find((c) => c.door === 'crm.add_meeting_evidence');
      assert.equal(evidence?.state, 'command', `${status} takes evidence`);
    }
    assert.equal(meetingControls('completed').find((c) => c.door === 'crm.request_meeting_analysis')?.state, 'command');
    for (const status of ['no_show', 'cancelled'] as const) {
      assert.ok(!meetingControls(status).some((c) => c.door === 'crm.request_meeting_analysis'), `${status} has nothing to analyse (§10.1)`);
    }
  });
});

describe('I. the timezone is always visible, the meeting’s first — and never a crash', () => {
  test('a meeting in the agency’s own zone shows one zone; another zone shows both', () => {
    assert.deepEqual(timezonePair('Asia/Kolkata', 'Asia/Kolkata'), { primary: 'Asia/Kolkata', secondary: null, unrecognised: null });
    assert.deepEqual(timezonePair('Europe/London', 'Asia/Kolkata'), { primary: 'Europe/London', secondary: 'Asia/Kolkata', unrecognised: null });
    assert.deepEqual(timezonePair(null, 'Asia/Kolkata'), { primary: 'Asia/Kolkata', secondary: null, unrecognised: null });
  });

  test('a zone the row holds that Intl does not know is said as unrecognised and the agency’s zone does the formatting', () => {
    // crm.meetings.timezone is free text; review found one bad row would take
    // three pages down with a RangeError. The row is shown, and the zone named.
    for (const bad of ['IST+5', 'India', 'Mars/Olympus', '', '   ']) {
      assert.equal(isKnownZone(bad), false, `${JSON.stringify(bad)} is not a known zone`);
      assert.deepEqual(timezonePair(bad, 'Asia/Kolkata'), { primary: 'Asia/Kolkata', secondary: null, unrecognised: bad });
    }
    assert.equal(isKnownZone('Asia/Calcutta'), true, 'an IANA alias is still a zone');
  });
});

describe('J. evidence visibility uses the vocabulary the CHECK holds', () => {
  test('client-visible evidence is information; internal is neutral; the vocabulary is the schema’s', () => {
    assert.deepEqual([...MEETING_EVIDENCE_VISIBILITIES], ['internal', 'client_visible']);
    assert.equal(evidenceTone('client_visible'), 'info');
    assert.equal(evidenceTone('internal'), 'neutral');
    assert.equal(evidenceTone('client'), 'neutral', 'the value the first draft compared against is not in the vocabulary, and is not special');
  });
});
