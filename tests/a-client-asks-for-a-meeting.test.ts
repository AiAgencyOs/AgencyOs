import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MEETING_DOORS, interpretRequest } from '../src/lib/scheduler/meeting-commands-eval.ts';

/**
 * A client asks for a meeting — Scheduler §3.1, §4.
 *
 * The Scheduler had a door for every state a meeting can reach and none that
 * brings one into existence. Found by driving the real flow on the test
 * number: the lead page could only say "no meeting has been requested", and
 * could say nothing else, because nothing could write one. The demonstration
 * two days earlier had inserted the row with a script — which is what hid it.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260914130000_a_client_asks_for_a_meeting.sql');
const LIB = read('src/lib/scheduler/meeting-commands.ts');
const PAGE = read('app/(internal)/leads/[leadId]/page.tsx');
const FORM = read('app/(internal)/leads/[leadId]/meeting-request-form.tsx');
const ACTIONS = read('app/(internal)/leads/[leadId]/meeting-request-actions.ts');

describe('A. the door exists, and it is the only one that creates a meeting', () => {
  test('crm.request_meeting is defined and answers by name', () => {
    assert.match(MIGRATION, /create or replace function crm\.request_meeting\(/);
    for (const name of ['requested', 'already_requested', 'invalid_request', 'invalid_timezone', 'unknown_lead', 'unknown_thread', 'unknown_message', 'no_actor', 'unknown_actor', 'forbidden']) {
      assert.match(MIGRATION, new RegExp(`'${name}'::text`), `${name} is documented but never returned`);
    }
  });

  test('every name the migration returns has a sentence, and a stranger is said as itself', () => {
    const names = [...MIGRATION.matchAll(/select '([a-z_]+)'::text/g)].map((m) => m[1]);
    assert.ok(names.length >= 10);
    for (const name of new Set(names)) {
      const decision = interpretRequest(name, null);
      assert.ok(decision.message.length > 0, `${name} has no sentence`);
    }
    const stranger = interpretRequest('who_knows', null);
    assert.equal(stranger.kind, 'error', 'an unrecognised name is never a success');
    assert.match(stranger.message, /who_knows/, 'and it is said as itself');
  });

  test('already_requested is a success — asking twice is not two meetings', () => {
    const twice = interpretRequest('already_requested', '11111111-1111-4111-8111-111111111111');
    assert.equal(twice.kind, 'done');
    assert.match(twice.message, /does not start a second one/);
    // And the migration's predicate is the live statuses, not all of them: a
    // concluded meeting must not block a client who asks again next month.
    assert.match(MIGRATION, /m\.status in \('requested', 'proposed', 'booked'\)/);
  });
});

describe('B. what it records, and what it refuses to decide', () => {
  test('the row lands in requested, and nothing is agreed', () => {
    const insert = MIGRATION.slice(MIGRATION.indexOf('insert into crm.meetings'));
    assert.match(insert, /'requested'\s*\n\s*\)/, 'the status is requested');
    // §4.1: what the client named goes in requested_*, never confirmed_*.
    assert.match(insert, /requested_start_at, requested_window_end/);
    assert.doesNotMatch(insert.slice(0, insert.indexOf('returning')), /confirmed_start_at|booked_mode|booking_key|provider_event_id/,
      'a request that filled in an agreement would be inventing one');
    assert.equal(interpretRequest('requested', null).message.includes('Nothing is agreed yet'), true);
  });

  test('the source message must belong to this agency AND to the named thread', () => {
    // A foreign key alone admits another conversation's message, which makes
    // §3.1's evidence a lie while the constraint stays happy.
    assert.match(MIGRATION, /m\.organization_id = v_lead\.organization_id\s*\n\s*and \(p_conversation_id is null or m\.conversation_id = p_conversation_id\)/);
  });

  test('the timezone is stored in its canonical spelling', () => {
    // is_known_timezone compares case-insensitively, so `asia/kolkata` passes
    // and would then be printed to a person exactly like that.
    assert.match(MIGRATION, /select z\.name into v_zone\s*\n\s*from pg_catalog\.pg_timezone_names z/);
  });

  test('it does not decide from a client’s words that a meeting was asked for', () => {
    const prose = MIGRATION.replace(/\n--\s?/g, ' ');
    assert.match(prose, /It does NOT read the client's message and decide that a meeting was asked/);
    // The property behind the prose: the door is TOLD which message carried
    // the request; it never goes looking for one. A door that picked a message
    // itself would be deciding what the client meant.
    const body = MIGRATION.slice(MIGRATION.indexOf('as $$'));
    assert.match(body, /p_requested_message_id uuid|p_requested_message_id/);
    assert.doesNotMatch(body, /order by m\.occurred_at|select .*from crm\.conversation_messages[\s\S]{0,120}order by/,
      'the door must not choose a message for itself');
  });
});

describe('C. the control is where a request actually arrives', () => {
  test('the lead page offers it, and the meeting page does not', () => {
    assert.match(PAGE, /<MeetingRequestForm leadId=\{leadId\} conversationId=\{conversation\?\.id \?\? null\}/);
    // A meeting page is the wrong place to request a meeting: the row already
    // exists by the time anybody is on it.
    const controls = read('app/(internal)/meetings/[meetingId]/controls.tsx');
    assert.match(controls, /const FORMS: Partial<Record<MeetingDoor, ComponentType<FormProps>>>/);
    assert.doesNotMatch(controls, /'crm\.request_meeting':/);
  });

  test('the page no longer claims no calendar is configured', () => {
    assert.doesNotMatch(PAGE, /no\s*\n?\s*calendar provider is configured \(BLK-005\)/);
    assert.match(PAGE, /A client who asks for one is recorded here/);
  });

  test('the zone comes from the settings, not from the form', () => {
    // A hidden field holding the timezone is a field somebody can edit, and
    // the zone decides what hour a client is told to turn up at.
    assert.doesNotMatch(FORM, /name="timezone"/);
    assert.match(ACTIONS, /getAgencyTimeZone/);
    // With no agency zone the form says so rather than recording a meeting
    // nobody can read a time from.
    assert.match(FORM, /the agency has not set one/);
  });

  test('the lead page is revalidated from the door’s answer, never the form field', () => {
    assert.match(ACTIONS, /if \(result\.data\.leadId\) revalidatePath\(`\/leads\/\$\{result\.data\.leadId\}`\)/);
  });

  test('and the door is in the one table the view, the lib and the tests share', () => {
    assert.equal(MEETING_DOORS['crm.request_meeting'].rpc, 'request_meeting');
    // Through the table, never a literal — the discipline the G-237 review
    // established, and which the first draft of this door broke.
    assert.match(LIB, /\.rpc\(MEETING_DOORS\['crm\.request_meeting'\]\.rpc/);
    assert.doesNotMatch(LIB, /\.rpc\('request_meeting'/);
  });
});
