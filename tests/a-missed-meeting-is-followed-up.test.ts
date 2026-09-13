import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RHYTHM_CLOCK,
  RHYTHM_OFFSETS,
  earliestAfter,
  maxAttempts,
  nextSendAt,
  spacingAfter,
} from '../src/modules/crm/follow-up-rhythms.ts';
import { SITUATIONS, isRunnable, situationFor } from '../src/modules/crm/follow-up-situations.ts';
import { greeting, situationBody } from '../src/modules/crm/follow-up-worker.ts';

/**
 * A missed meeting is followed up — ADM-103.
 *
 * The decision answered on 2026-09-13, after `crm.record_no_show` had spent a
 * fortnight writing `follow_up: none - ADM-103 open` into the audit row of
 * every no-show. What is asserted here is the *answer*, not a plausible
 * cadence: two hours after the agreed start, a day after that, and no third —
 * on a clock no rhythm before it used.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260913160000_a_missed_meeting_is_followed_up.sql');
const DOOR = read('supabase/migrations/20260912140000_a_meeting_is_concluded_by_a_person.sql');
const WORKER = read('src/modules/crm/follow-up-worker.ts');

const ZONE = 'Asia/Kolkata';
/** A Monday, 11:00 in Kolkata — inside the sending window, mid-week. */
const MONDAY_11 = new Date('2026-09-14T05:30:00.000Z');

describe('A. the cadence is the owner’s, on a clock the other rhythms do not use', () => {
  test('two hours, then a day after that, and there is no third number', () => {
    assert.deepEqual(RHYTHM_OFFSETS.meeting_missed, [2, 26]);
    assert.equal(maxAttempts('meeting_missed'), 2, 'maximum two, then a person');
    assert.equal(RHYTHM_CLOCK.meeting_missed, 'hour');
    // 26 rather than 24: a day after the FIRST NUDGE, which is what "second
    // 1 day later" means when the first is two hours in.
    assert.equal(spacingAfter('meeting_missed', 1), 24);
  });

  test('every other rhythm still counts business days, and still says so', () => {
    for (const rhythm of ['sales_active', 'sales_nurture', 'customer_success', 'internal_approval'] as const) {
      assert.equal(RHYTHM_CLOCK[rhythm], 'business_day', `${rhythm} changed clock`);
    }
    // The four ADM-69 recorded are untouched by ADM-103.
    assert.deepEqual(RHYTHM_OFFSETS.sales_active, [2, 5, 8, 11, 14, 17, 20]);
    assert.deepEqual(RHYTHM_OFFSETS.internal_approval, [1, 2, 3]);
  });

  test('the first nudge lands two hours after the meeting, not two days', () => {
    const first = nextSendAt({ triggeredAt: MONDAY_11, rhythm: 'meeting_missed', attemptsSoFar: 0, timeZone: ZONE });
    assert.ok(first);
    assert.equal(first!.getTime() - MONDAY_11.getTime(), 2 * 3_600_000);

    // Read as business days — the defect this clock exists to prevent — the
    // same offset would have landed on Wednesday.
    const asDays = nextSendAt({ triggeredAt: MONDAY_11, rhythm: 'sales_active', attemptsSoFar: 0, timeZone: ZONE });
    assert.ok(asDays && asDays.getTime() - MONDAY_11.getTime() > 24 * 3_600_000);
  });

  test('the second is a day after the first, and then it stops', () => {
    const second = nextSendAt({ triggeredAt: MONDAY_11, rhythm: 'meeting_missed', attemptsSoFar: 1, timeZone: ZONE });
    assert.ok(second);
    assert.equal(second!.getTime() - MONDAY_11.getTime(), 26 * 3_600_000);
    assert.equal(
      nextSendAt({ triggeredAt: MONDAY_11, rhythm: 'meeting_missed', attemptsSoFar: 2, timeZone: ZONE }),
      null,
      'a third attempt is not scheduled — the thread goes to a person',
    );
  });

  test('a nudge owed in the middle of the night waits for the morning', () => {
    // A meeting missed at 23:30 Kolkata: two hours later is 01:30, which is
    // not a time to message a client. The window moves it, it is not dropped.
    const lateMeeting = new Date('2026-09-14T18:00:00.000Z'); // 23:30 IST
    const due = nextSendAt({ triggeredAt: lateMeeting, rhythm: 'meeting_missed', attemptsSoFar: 0, timeZone: ZONE });
    assert.ok(due);
    const hourIst = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hour12: false }).format(due!),
    );
    assert.ok(hourIst >= 10 && hourIst < 19, `sent at ${hourIst}:00 IST, outside the window`);
    assert.ok(due!.getTime() > lateMeeting.getTime(), 'and never earlier than the meeting');
  });

  test('the floor after a real send is counted in hours too, not business days', () => {
    const sentAt = new Date('2026-09-14T06:00:00.000Z'); // 11:30 IST Monday
    const floor = earliestAfter('meeting_missed', 1, sentAt, ZONE);
    // 24 hours later is 11:30 IST Tuesday — inside the window, so unmoved.
    assert.equal(floor.getTime() - sentAt.getTime(), 24 * 3_600_000);
    // The same spacing read as business days would be a day and a half later.
    const asDays = earliestAfter('sales_active', 1, sentAt, ZONE);
    assert.ok(asDays.getTime() > floor.getTime());
  });
});

describe('B. it is a situation of its own, and it is runnable', () => {
  test('the ninth situation is missed_meeting, and it is not one of ADM-69’s eight reused', () => {
    const s = situationFor('missed_meeting');
    assert.ok(s, 'the situation exists');
    assert.equal(s!.ordinal, 9);
    assert.equal(s!.rhythm, 'meeting_missed');
    assert.ok(isRunnable(s!), 'automated, and nothing blocks it');
    // The near miss: abandoned_conversation is the closest of the eight and
    // says something else entirely.
    assert.notEqual(s!.key, 'abandoned_conversation');
    assert.equal(SITUATIONS.filter((x) => x.rhythm === 'meeting_missed').length, 1);
  });

  test('a client reads it, so consent governs it — and it escalates to a person', () => {
    const s = situationFor('missed_meeting')!;
    assert.equal(s.audience, 'client_consent');
    assert.equal(s.escalatesTo, 'sales_agent_then_owner');
    assert.ok(s.stopsOn.includes('opt_out'));
  });
});

describe('C. the words are the owner’s, and they survive a missing name', () => {
  test('each attempt has its own sentence, and there is no third', () => {
    const first = situationBody('missed_meeting', 1, 'Rajesh Kumar');
    const second = situationBody('missed_meeting', 2, 'Rajesh Kumar');
    assert.equal(first, 'Hi Rajesh, aaj hum aapse call par mil nahi paaye. Koi baat nahi — kya hum koi aur time rakh lein?');
    assert.equal(second, 'Hi Rajesh, kal wali call reschedule karni ho to bata dijiye, main time bhej deta hoon.');
    assert.equal(situationBody('missed_meeting', 3, 'Rajesh'), null, 'no words for an attempt that never happens');
  });

  test('neither message complains, and both ask for another time', () => {
    for (const attempt of [1, 2]) {
      const body = situationBody('missed_meeting', attempt, 'A')!;
      assert.doesNotMatch(body, /missed you|no show|did not|nahi aaye|kyun/i, 'it does not accuse');
      assert.match(body, /time|reschedule/i, 'it asks for another time');
      assert.doesNotMatch(body, /\d/, 'no price, no date, no number — nothing was agreed');
    }
  });

  test('an unrecorded name loses the greeting rather than inventing one', () => {
    assert.equal(greeting(null), '');
    assert.equal(greeting('   '), '');
    assert.equal(greeting('Priya Sharma'), 'Hi Priya, ');
    // A pasted paragraph in the name column is not a greeting.
    assert.equal(greeting('x'.repeat(41)), '');
    const body = situationBody('missed_meeting', 1, null)!;
    assert.ok(body.startsWith('Aaj hum aapse'), body.slice(0, 30));
    assert.doesNotMatch(body, /Hi ,|\{name\}|undefined|null/);
  });

  test('every other situation still sends the placeholder nobody approved words for', () => {
    for (const s of SITUATIONS) {
      if (s.key === 'missed_meeting') continue;
      assert.equal(situationBody(s.key, 1, 'A'), null, `${s.key} gained prose nobody approved`);
    }
  });

  test('the agent’s draft still outranks these words when the organization turned it on', () => {
    const composed = WORKER.slice(WORKER.indexOf('async function bodyFor'));
    assert.match(composed, /const fallback = approved \?\? FOLLOW_UP_BODY;/);
    assert.match(composed, /return row\?\.drafted_body\?\.trim\(\) \|\| fallback;/);
  });
});

describe('D. the sequence is about the meeting, and the door starts it', () => {
  test('a meeting is a subject a sequence may have', () => {
    assert.match(MIGRATION, /follow_up_sequences_subject_type_check check \(subject_type in \([\s\S]*?'meeting'/);
    // Keyed on the lead, a second no-show would collide with the first
    // sequence's unique key and send nothing. The comment says why; this
    // asserts the value.
    assert.match(WORKER, /seq\.subject_type === 'meeting'/);
  });

  test('the door starts it, triggered at the agreed start rather than at the moment of recording', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function crm.record_no_show'));
    assert.match(fn, /crm\.start_follow_up_sequence\(/);
    assert.match(fn, /'missed_meeting',\s*\n\s*'meeting',/);
    assert.match(fn, /coalesce\(v_row\.confirmed_start_at, clock_timestamp\(\)\)/);
    // The conversation and the contact are carried through, or the consent
    // chokepoint has nothing to check.
    assert.match(fn, /v_row\.conversation_id,\s*\n\s*v_row\.contact_id/);
  });

  test('and the audit row no longer says the decision is open', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function crm.record_no_show'));
    assert.doesNotMatch(fn, /none - ADM-103 open/);
    assert.match(fn, /'follow_up', jsonb_build_object\(/);
    assert.match(fn, /'sequence_id', v_sequence/);
    assert.match(DOOR, /none - ADM-103 open/, 'the earlier migration is history and keeps its words');
  });

  test('every guard the door had is still there, and the grants are unchanged', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function crm.record_no_show'));
    for (const guard of ['no_actor', 'unknown_actor', 'forbidden', 'not_found', 'wrong_state', 'already_recorded', 'not_yet_started', 'note_too_long']) {
      assert.match(fn, new RegExp(`'${guard}'::text`), `${guard} was lost in the carry-forward`);
    }
    assert.match(fn, /core\.can_write\(\)/);
    assert.match(fn, /crm\.add_meeting_evidence\(v_row\.id, 'notes', p_note, 'internal'\)/);
    // A revoke-from-public that forgets service_role silently narrows a door.
    assert.match(MIGRATION, /grant execute on function crm\.record_no_show\(uuid, text\) to authenticated, service_role;/);
  });

  test('a template has a situation to answer, and no template row is written', () => {
    assert.match(MIGRATION, /whatsapp_templates_situation_key_check check \(situation_key in \([\s\S]*?'missed_meeting'/);
    // The eleven that were already admitted are all still admitted.
    for (const key of ['no_response_after_quotation', 'no_response_after_requirements', 'no_response_after_proposal', 'abandoned_conversation', 'pending_approval', 'inactive_lead', 'post_project', 'internal_approval', 'quotation_approved', 'internal_notice', 'agent_message']) {
      assert.match(MIGRATION, new RegExp(`'${key}'`), `${key} was dropped from the situation vocabulary`);
    }
    assert.doesNotMatch(MIGRATION, /insert into crm\.whatsapp_templates/, 'Meta approves the words, not a migration');
  });
});

describe('E2. the door leaves the arithmetic to the worker, and the worker does it', () => {
  test('the door writes no due time — a migration would have to restate the rhythm and the window', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function crm.record_no_show'));
    assert.doesNotMatch(fn, /next_due_at/, 'the cadence belongs to one place, and it is not SQL');
  });

  test('and the pass that fills it in is not conditioned on a missing timezone', () => {
    // The trap: a sequence with a null next_due_at never appears in
    // crm.due_follow_up_sequences, so a door-started one that nothing
    // scheduled would sit silent forever. This pass is what saves it, and it
    // predates ADM-103 — so what is asserted is that it still takes ANY
    // active unscheduled sequence, not only the timezone case.
    const pass = WORKER.slice(WORKER.indexOf('schedule what was started with no due time'));
    const query = pass.slice(pass.indexOf(".from('follow_up_sequences')"), pass.indexOf('.limit(BATCH)'));
    assert.match(query, /\.eq\('status', 'active'\)/);
    assert.match(query, /\.is\('next_due_at', null\)/);
    assert.doesNotMatch(query, /\.eq\('situation_key'/, 'it must not narrow to one situation');
    assert.equal((query.match(/\.eq\(/g) ?? []).length, 1, 'being active is the only equality it filters on');
    // And it schedules from the sequence's own trigger and attempt count,
    // which for a missed meeting is the agreed start and zero.
    assert.match(pass, /triggeredAt: new Date\(seq\.triggered_at\)/);
    assert.match(pass, /attemptsSoFar: seq\.attempts_sent/);
  });

  test('a no-show recorded late does not fire both nudges at once', () => {
    // The meeting was missed three days ago and somebody only now marked it.
    // Both offsets are in the past, so the absolute schedule says "now" twice;
    // the floor after the real send is what keeps them a day apart.
    const missed = new Date('2026-09-14T05:30:00.000Z');
    const first = nextSendAt({ triggeredAt: missed, rhythm: 'meeting_missed', attemptsSoFar: 0, timeZone: ZONE })!;
    const second = nextSendAt({ triggeredAt: missed, rhythm: 'meeting_missed', attemptsSoFar: 1, timeZone: ZONE })!;
    assert.ok(second.getTime() - first.getTime() === 24 * 3_600_000);
    const sentNow = new Date('2026-09-17T06:00:00.000Z');
    const floor = earliestAfter('meeting_missed', 1, sentNow, ZONE);
    assert.ok(floor.getTime() >= sentNow.getTime() + 24 * 3_600_000, 'the second waits a day after the first actually went');
  });
});

describe('E. the sequence stops for the reasons the owner named', () => {
  test('rescheduled, rebooked, and a row that stopped being a no-show', () => {
    const arm = WORKER.slice(WORKER.indexOf("seq.subject_type === 'meeting'"));
    const body = arm.slice(0, arm.indexOf("if (seq.subject_type === 'project')"));
    // Rescheduled is the SUCCESSOR row (G-244 mints a new one), not a status.
    assert.match(body, /\.eq\('supersedes_id', seq\.subject_id\)/);
    assert.match(body, /stops\.push\('meeting_rescheduled'\)/);
    // Rebooked is another meeting for the same lead, now booked.
    assert.match(body, /\.eq\('status', 'booked'\)[\s\S]*?\.neq\('id', seq\.subject_id\)/);
    assert.match(body, /stops\.push\('meeting_rebooked'\)/);
    assert.match(body, /stateChanged: data\.status !== 'no_show'/);
    // A deleted meeting stops the sequence rather than failing it forever.
    assert.match(body, /if \(!data\) return \{ present: false \};/);
  });

  test('the stop conditions the situation names are the ones the worker can produce', () => {
    const s = situationFor('missed_meeting')!;
    const arm = WORKER.slice(WORKER.indexOf("seq.subject_type === 'meeting'"));
    for (const condition of s.stopsOn) {
      // `reply` and `opt_out` are the shared paths every client situation
      // uses; the two meeting ones must be produced by this arm.
      if (condition === 'reply' || condition === 'opt_out') continue;
      assert.match(arm, new RegExp(`'${condition}'`), `${condition} is named but never produced`);
    }
  });
});
