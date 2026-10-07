// P1-SCHED-030 / P1-FLOW-028..032: the admin hears about a meeting, and the reminder sender exists.
// Proved against a stand-in database: the reads are for the JOB's organization, the re-check at fire time drops a cancelled or moved meeting, and a
// good one reaches the internal-channel send exactly once with a key that names the meeting and its time.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  announceMeetingBooked,
  announceMeetingCancelled,
  meetingBookedAnnouncementFor,
  meetingWhen,
  sendMeetingReminder,
} from '../src/modules/crm/meeting-announcements.ts';

const MID = '11111111-1111-4111-8111-111111111111';
const START = '2026-12-01T10:00:00+05:30';

type Tables = { meetings?: Record<string, unknown> | null; leads?: Record<string, unknown> | null; conversations?: Record<string, unknown>[] };

function fake(tables: Tables) {
  const sends: Record<string, unknown>[] = [];
  const reads: { table: string; filters: Record<string, unknown> }[] = [];
  const admin = {
    schema: () => ({
      from(table: 'meetings' | 'leads' | 'conversations') {
        const filters: Record<string, unknown> = {};
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => {
            filters[c] = v;
            return q;
          },
          in: () => q,
          neq: () => q,
          maybeSingle: () => {
            reads.push({ table, filters: { ...filters } });
            return Promise.resolve({ data: tables[table as 'meetings' | 'leads'] ?? null, error: null });
          },
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: tables.conversations ?? [], error: null }).then(res),
        };
        return q;
      },
      rpc(fn: string, args: Record<string, unknown>) {
        if (fn === 'send_outbound_message') sends.push(args);
        // 'already_sent' + 'sent' is the idempotent-replay answer: the handler stops there, which is enough to prove it reached the send exactly once
        return Promise.resolve({ data: [{ outcome: 'already_sent', message_id: 'm1', to_phone: null, from_phone_number_id: null, recipient_type: 'group', delivery: 'sent' }], error: null });
      },
    }),
  };
  return { admin: admin as never, sends, reads };
}

const BOOKED = { id: MID, lead_id: 'l1', status: 'booked', confirmed_start_at: START, timezone: 'Asia/Kolkata', booked_mode: 'video_meeting', purpose: 'scope', cancellation_reason: null };
const job = (event: unknown) => ({ id: 'j1', organization_id: 'org1', correlation_id: null, payload: { event } });

test('a booked meeting is announced from the ROW, for the job organization, once per time', async () => {
  const { admin, reads } = fake({ meetings: BOOKED, leads: { title: 'Acme' }, conversations: [] });
  const out = await announceMeetingBooked(admin, job({ meetingId: MID }));
  assert.equal(out.status, 'succeeded');
  assert.equal(reads[0]?.filters.organization_id, 'org1');
  assert.equal(reads[0]?.table, 'meetings');
});

test('a meeting that is no longer booked, or no longer exists, is not announced', async () => {
  const moved = await announceMeetingBooked(fake({ meetings: { ...BOOKED, status: 'cancelled' } }).admin, job({ meetingId: MID }));
  assert.equal(moved.status === 'succeeded' && moved.outcome, 'not_mine');
  const gone = await announceMeetingBooked(fake({ meetings: null }).admin, job({ meetingId: MID }));
  assert.equal(gone.status === 'succeeded' && gone.outcome, 'not_mine');
  const bad = await announceMeetingBooked(fake({}).admin, job({ meetingId: 'nope' }));
  assert.equal(bad.status === 'failed' && bad.permanent, true);
});

test('only a meeting that HAD been booked announces its cancellation', async () => {
  const never = await announceMeetingCancelled(fake({ meetings: { ...BOOKED, status: 'cancelled' } }).admin, job({ meetingId: MID, wasBooked: false }));
  assert.equal(never.status === 'succeeded' && never.outcome, 'not_mine');
  const wrongState = await announceMeetingCancelled(fake({ meetings: BOOKED }).admin, job({ meetingId: MID, wasBooked: true }));
  assert.equal(wrongState.status === 'succeeded' && wrongState.outcome, 'not_mine');
});

const reminder = { meeting_id: MID, scheduled_for_start_at: START, lead_minutes: 10 };
const rjob = (payload: unknown) => ({ id: 'j2', organization_id: 'org1', correlation_id: null, payload });
const NEAR = '2026-12-01T04:35:00Z'; // 10:00 IST is 04:30Z, so this is 5 minutes AFTER the start (past the 2-minute grace)

test('the reminder sender drops a cancelled meeting and a meeting that moved', async () => {
  // start 10:00 IST = 04:30Z; the window is 04:20Z..04:32Z
  const inWindow = '2026-12-01T04:22:00Z';
  const cancelled = await sendMeetingReminder(fake({ meetings: { ...BOOKED, status: 'cancelled' } }).admin, rjob(reminder), inWindow);
  assert.equal(cancelled.status === 'succeeded' && cancelled.outcome, 'dropped_cancelled');
  const moved = await sendMeetingReminder(fake({ meetings: { ...BOOKED, confirmed_start_at: '2026-12-01T11:00:00+05:30' } }).admin, rjob(reminder), inWindow);
  assert.equal(moved.status === 'succeeded' && moved.outcome, 'dropped_moved');
  const gone = await sendMeetingReminder(fake({ meetings: null }).admin, rjob(reminder), inWindow);
  assert.equal(gone.status === 'succeeded' && gone.outcome, 'dropped');
});

test('too early is retried, too late is dropped, malformed is parked', async () => {
  const early = await sendMeetingReminder(fake({ meetings: BOOKED }).admin, rjob(reminder), '2026-12-01T03:00:00Z');
  assert.equal(early.status === 'failed' && early.permanent, false);
  const late = await sendMeetingReminder(fake({ meetings: BOOKED }).admin, rjob(reminder), NEAR);
  assert.equal(late.status === 'succeeded' && late.outcome, 'dropped_too_late');
  const bad = await sendMeetingReminder(fake({ meetings: BOOKED }).admin, rjob({ meeting_id: MID }), NEAR);
  assert.equal(bad.status === 'failed' && bad.permanent, true);
});

test('a good reminder reaches the internal-channel send exactly once, keyed by meeting, lead time and start', async () => {
  const f = fake({ meetings: BOOKED, leads: { title: 'Acme' }, conversations: [{ id: 'c1', kind: 'internal_group' }] });
  const out = await sendMeetingReminder(f.admin, rjob(reminder), '2026-12-01T04:22:00Z');
  assert.equal(out.status, 'succeeded');
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]?.p_conversation_id, 'c1');
  assert.equal(f.sends[0]?.p_external_ref, `meeting-reminder:${MID}:10:${START}`);
  assert.match(String(f.sends[0]?.p_body), /Acme/);
  assert.match(String(f.sends[0]?.p_body), /10 minutes/);
});

test('the wording names the lead and the time in the meeting\'s own zone', () => {
  assert.match(meetingWhen(START, 'Asia/Kolkata'), /Asia\/Kolkata/);
  assert.equal(meetingWhen(null, null), 'a time that is not set');
  const text = meetingBookedAnnouncementFor({ leadTitle: 'Acme', when: 'tomorrow', mode: 'video_meeting', purpose: null });
  assert.match(text, /Lead: Acme/);
  assert.match(text, /video meeting/);
});
