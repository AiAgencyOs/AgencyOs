import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import {
  SCHEDULING_DROPS,
  SCHEDULING_INTENTS,
  SCHEDULING_REFUSALS,
  decideScheduling,
  endOfDayInZone,
  isImportedMessage,
  localDateLine,
  theirWords,
  schedulingRequestSchema,
  zonedInstant,
  type SchedulingRequest,
} from '../src/modules/crm/scheduling-request.ts';

/**
 * A client asking for a call is noticed — G-249, Scheduler §3.1, §3.3, §4.1–§4.3.
 *
 * G-248 built the door and left `p_requested_message_id` unused. This is the
 * caller. What is asserted is the specification's own vocabulary and the rule
 * that decides what a reading means — including the four intents that are read
 * and deliberately not acted on, which is the part easiest to lose.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
const CATALOG = read('src/lib/events/catalog.ts');
const MODULE = read('src/modules/crm/scheduling-request.ts');

const NOW = new Date('2026-09-16T06:00:00.000Z'); // 11:30 IST
const IST = 'Asia/Kolkata';
/** Every call gives the zone: a rule that reads its own would be untestable. */
const decide = (r: SchedulingRequest, now: Date = NOW, zone: string | null = IST) => decideScheduling(r, now, zone);
const base = (over: Partial<SchedulingRequest> = {}): SchedulingRequest => ({
  intent: 'call',
  explicit: true,
  mode: null,
  startAt: null,
  windowEnd: null,
  evidence: 'kal 4 baje call kar sakte hain?',
  ...over,
});

describe('A. §3.1’s vocabulary, whole', () => {
  test('all six scheduling intents are read, plus none', () => {
    // "Identify scheduling intent: call, meeting, reschedule, cancel,
    // reminder question, availability question."
    assert.deepEqual([...SCHEDULING_INTENTS], [
      'call', 'meeting', 'reschedule', 'cancel', 'reminder_question', 'availability_question', 'none',
    ]);
  });

  test('and four of the six are read WITHOUT being acted on, each said as itself', () => {
    for (const intent of ['reschedule', 'cancel', 'reminder_question', 'availability_question'] as const) {
      const d = decide(base({ intent }));
      assert.equal(d.act, 'none', `${intent} must not create a meeting`);
      if (d.act === 'none') {
        assert.equal(d.reason, 'other_intent');
        assert.equal(d.detail, intent, 'the log says which one the client actually asked for');
      }
    }
    // Not scheduling at all is its own answer, not the same one.
    const none = decide(base({ intent: 'none' }));
    assert.ok(none.act === 'none' && none.reason === 'not_scheduling');
  });

  test('every refusal has a sentence, and none of them reads as success', () => {
    for (const [reason, sentence] of Object.entries(SCHEDULING_REFUSALS)) {
      assert.ok(sentence.length > 20, `${reason} has no real sentence`);
    }
    assert.match(SCHEDULING_REFUSALS.not_explicit, /§3\.3/, 'the ambiguous case names what the spec wants instead');
  });
});

describe('B. explicit or ambiguous — §3.1, and §3.3’s answer', () => {
  test('an ambiguous request creates nothing, and says why', () => {
    const d = decide(base({ explicit: false }));
    assert.ok(d.act === 'none' && d.reason === 'not_explicit');
  });

  test('the clarification question §3.3 asks for is NOT sent from here', () => {
    // It reaches a client, so it is a different act with a different gate.
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.doesNotMatch(slice, /send_outbound_message|reply/i, 'nothing here answers the client');
    assert.match(slice, /workClass: 'internal_plan'/, 'it answers nobody, and the work class says so');
  });
});

describe('C. §4.1–§4.3 — mode, date, time, and what is never invented', () => {
  test('the mode is the client’s when they gave one', () => {
    const d = decide(base({ intent: 'meeting', mode: 'video_meeting' }));
    assert.ok(d.act === 'request' && d.mode === 'video_meeting');
  });

  test('a call with no mode is a call; a meeting with no mode is `other`, not a guess', () => {
    const call = decide(base({ intent: 'call', mode: null }));
    assert.ok(call.act === 'request' && call.mode === 'call', 'they said call in the intent');
    const meeting = decide(base({ intent: 'meeting', mode: null }));
    assert.ok(meeting.act === 'request' && meeting.mode === 'other', '"meeting" does not say video or in person');
  });

  test('§4.2: a time that resolves to the PAST drops the time, never the request', () => {
    const d = decide(base({ startAt: '2026-09-15T10:00:00.000Z' }));
    // The client still asked to meet. What is dropped is the hour, not the ask.
    assert.ok(d.act === 'request', 'a past time must not swallow the request');
    if (d.act === 'request') {
      assert.equal(d.startAt, null);
      assert.equal(d.windowEnd, null);
    }
  });

  test('§4.3: a range is carried whole, and a backwards one loses only its end', () => {
    const range = decide(base({ startAt: '2026-09-17T12:30:00.000Z', windowEnd: '2026-09-17T14:30:00.000Z' }));
    assert.ok(range.act === 'request' && range.startAt === '2026-09-17T12:30:00.000Z' && range.windowEnd === '2026-09-17T14:30:00.000Z');
    const backwards = decide(base({ startAt: '2026-09-17T14:30:00.000Z', windowEnd: '2026-09-17T12:30:00.000Z' }));
    assert.ok(backwards.act === 'request' && backwards.startAt === '2026-09-17T14:30:00.000Z' && backwards.windowEnd === null);
  });

  test('a window with no start is not sent — the door refuses it by name', () => {
    const d = decide(base({ startAt: null, windowEnd: '2026-09-17T14:30:00.000Z' }));
    assert.ok(d.act === 'request' && d.startAt === null && d.windowEnd === null);
  });

  test('an unparseable time is null, never NaN', () => {
    const d = decide(base({ startAt: 'tomorrow-ish' }));
    assert.ok(d.act === 'request' && d.startAt === null);
  });

  test('the schema refuses a mode or an intent it was not given', () => {
    assert.equal(schedulingRequestSchema.safeParse({ ...base(), intent: 'lunch' }).success, false);
    assert.equal(schedulingRequestSchema.safeParse({ ...base(), evidence: '' }).success, false, 'evidence is the client’s words, and there are always some');
    // A mode outside §4.1's four falls back to null rather than failing the
    // whole reading — the request survives, the invention does not.
    const odd = schedulingRequestSchema.safeParse({ ...base(), mode: 'telepathy' });
    assert.ok(odd.success && odd.data.mode === null);
  });

  test('a wall-clock time with no offset is resolved in the AGENCY’s zone, not the host’s', () => {
    // The bug this kills: Date.parse('2026-09-17T16:00:00') means the HOST's
    // local time, production runs UTC, and the row's own timezone column says
    // Asia/Kolkata — so 4 PM was stored as 21:30 IST and rendered confidently.
    // Every fixture in the first draft carried a Z, so the suite was blind.
    const d = decide(base({ startAt: '2026-09-17T16:00:00' }));
    assert.ok(d.act === 'request');
    if (d.act === 'request') assert.equal(d.startAt, '2026-09-17T10:30:00.000Z', '4 PM in Kolkata is 10:30Z');
    // And an answer that DOES carry an offset is honoured as given.
    const explicit = decide(base({ startAt: '2026-09-17T16:00:00Z' }));
    assert.ok(explicit.act === 'request' && explicit.startAt === '2026-09-17T16:00:00.000Z');
  });

  test('the zone resolution survives a daylight-saving boundary', () => {
    // 2026-03-29 is the spring forward in Europe/London: 00:30 is GMT, 02:30 is BST.
    assert.equal(zonedInstant('2026-03-29T00:30', 'Europe/London')?.toISOString(), '2026-03-29T00:30:00.000Z');
    assert.equal(zonedInstant('2026-03-29T02:30', 'Europe/London')?.toISOString(), '2026-03-29T01:30:00.000Z');
    assert.equal(zonedInstant('not a time', IST), null);
  });

  test('§4.3: a DATE with no time is the whole of that day, not midnight', () => {
    // The first draft made 2026-09-17 mean midnight UTC = 05:30 IST, so a
    // client who said "Thursday" was recorded as asking for a 5:30 AM meeting.
    const d = decide(base({ startAt: '2026-09-17' }));
    assert.ok(d.act === 'request');
    if (d.act === 'request') {
      assert.equal(d.startAt, '2026-09-16T18:30:00.000Z', 'the start of the 17th in Kolkata');
      assert.equal(d.windowEnd, '2026-09-17T18:29:00.000Z', 'and its end');
      assert.equal(d.dropped, null);
    }
    assert.equal(endOfDayInZone('2026-09-17', IST)?.toISOString(), '2026-09-17T18:29:00.000Z');
  });

  test('§4.3: "today" keeps the rest of today rather than resolving into the past', () => {
    // A date-only TODAY begins before `now`. The first draft called that past
    // and threw the date away — the one fact the client gave.
    const d = decide(base({ startAt: '2026-09-16' }));
    assert.ok(d.act === 'request');
    if (d.act === 'request') {
      assert.equal(d.startAt, NOW.toISOString(), 'clamped to now, not dropped');
      assert.equal(d.windowEnd, '2026-09-16T18:29:00.000Z');
      assert.equal(d.dropped, null);
    }
  });

  test('§4.4: with no agency timezone nothing is created, and UTC is not invented', () => {
    // core.organizations.timezone is null BY DESIGN. Writing UTC onto the row
    // would make §4.4's "store the timezone used" a durable false claim.
    const d = decide(base({ startAt: '2026-09-17T16:00:00' }), NOW, null);
    assert.ok(d.act === 'none' && d.reason === 'no_timezone');
    assert.match(SCHEDULING_REFUSALS.no_timezone, /§4\.4/);
  });

  test('every drop is named, reachable, and carries a sentence', () => {
    // Review found two refusal names that no code path could ever return,
    // declared with sentences so they read as covered.
    const produced = new Set<string>();
    for (const r of [
      base({ startAt: '2026-09-15T10:00:00Z' }),
      base({ startAt: '2026-09-17T14:30:00Z', windowEnd: '2026-09-17T12:30:00Z' }),
      base({ startAt: null, windowEnd: '2026-09-17T14:30:00Z' }),
      base({ startAt: 'tomorrow-ish' }),
    ]) {
      const d = decide(r);
      if (d.act === 'request' && d.dropped) produced.add(d.dropped);
    }
    assert.deepEqual([...produced].sort(), Object.keys(SCHEDULING_DROPS).sort(), 'a drop nobody can produce reads as covered');
    for (const [name, sentence] of Object.entries(SCHEDULING_DROPS)) {
      assert.ok(sentence.length > 20, `${name} has no sentence`);
      assert.match(sentence, /request/i, 'every drop keeps the request, and says so');
    }
  });

  test('every refusal is reachable too', () => {
    const produced = new Set<string>();
    for (const [r, zone] of [
      [base({ intent: 'none' }), IST],
      [base({ intent: 'cancel' }), IST],
      [base({ explicit: false }), IST],
      [base(), null],
    ] as const) {
      const d = decide(r, NOW, zone);
      if (d.act === 'none') produced.add(d.reason);
    }
    assert.deepEqual([...produced].sort(), Object.keys(SCHEDULING_REFUSALS).sort());
  });

  test('§4.2’s relative dates are resolved against a date the model is TOLD', () => {
    const line = localDateLine(NOW, 'Asia/Kolkata');
    assert.match(line, /Asia\/Kolkata/);
    assert.match(line, /16 September 2026/, 'the local date, not the UTC one');
    assert.match(line, /Resolve any relative date against that/);
  });
});

describe('D. the caller the door was waiting for', () => {
  test('it passes the message that carried the request — §3.1’s evidence', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /\.rpc\('request_meeting', \{/);
    assert.match(slice, /p_requested_message_id: message\.id/);
    assert.match(slice, /p_conversation_id: conversation\.id/);
    // G-248 built that argument and nothing used it. This is what changed.
    assert.match(read('supabase/migrations/20260914130000_a_client_asks_for_a_meeting.sql'), /p_requested_message_id uuid/);
  });

  test('§3.1’s "only once per logical inbound request" is asked BEFORE the model call', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    const liveCheck = slice.indexOf(".in('status', ['requested', 'proposed', 'booked'])");
    const modelCall = slice.indexOf('await callModel');
    assert.ok(liveCheck > 0 && modelCall > liveCheck, 'a lead already being scheduled must not cost a model call');
  });

  test('it declines a staff message, a threadless conversation, and a lead with a meeting open', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /message\.author_type !== 'client'/);
    assert.match(slice, /!conversation\?\.lead_id/);
    assert.match(slice, /a meeting is already open for this lead/);
    // A read that FAILED is not a message that was deleted (G-054).
    assert.match(slice, /if \(messageError\) \{[\s\S]{0,200}failJob/);
  });

  test('`already_requested` settles and anything else the door says fails the job', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /outcome !== 'requested' && outcome !== 'already_requested'/);
    assert.match(slice, /the door answered \$\{outcome\}/);
  });

  test('the local date actually reaches the model, and the zone the rule', () => {
    // Review: the first draft tested localDateLine in isolation, so deleting
    // the call from the workflow left the suite green while §4.2 stopped working.
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /content: \[localDateLine\(new Date\(\), zone \?\? 'UTC'\), clientTurn\(message\)\]/);
    assert.match(slice, /decideScheduling\(validated\.data, new Date\(\), zone\)/);
    // The zone read distinguishes a failure from an unset value (G-054), and
    // the door is never handed a fabricated one.
    assert.match(slice, /if \(!zoneRead\.ok\) \{[\s\S]{0,160}failJob/);
    assert.doesNotMatch(slice, /p_timezone: zone \?\? 'UTC'/, 'a fabricated zone is a durable false claim');
    assert.match(slice, /p_timezone: zone as string/);
  });

  test('the two pre-model guards are FUNCTIONS, and they answer correctly', () => {
    // Review red-proved the first draft of these by wrapping each guard in
    // `false &&`: the suite stayed green, because the assertions matched the
    // sentence beside the guard rather than the guard. Predicates now.
    assert.equal(isImportedMessage({ imported: true, import_record_id: 'x' }), true);
    assert.equal(isImportedMessage({ imported: false }), false);
    assert.equal(isImportedMessage({}), false);
    assert.equal(isImportedMessage(null), false);
    assert.equal(isImportedMessage(undefined), false);
    // A string "true" is not the boolean the import writes.
    assert.equal(isImportedMessage({ imported: 'true' }), false);

    assert.equal(theirWords({ body: 'kal call?', caption: null, spoken: null }), true);
    assert.equal(theirWords({ body: null, caption: 'kal call?', spoken: null }), true);
    assert.equal(theirWords({ body: null, caption: null, spoken: 'kal call?' }), true);
    assert.equal(theirWords({ body: '   ', caption: null, spoken: null }), false, 'whitespace is not words');
    assert.equal(theirWords({ body: null, caption: null, spoken: null }), false);
  });

  test('an imported history does not manufacture a request', () => {
    // crm.commit_import_record writes every inbound line as author_type
    // 'client' with metadata.imported, and emit_message_received fires for
    // each — which is harmless for a label, a qualification and a summary, and
    // is twelve hundred leads of fabricated scheduling work for this one.
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /if \(isImportedMessage\(message\.metadata\)\) \{/);
    const declineAt = slice.indexOf('an imported history is not a request made now');
    assert.ok(declineAt > 0 && declineAt < slice.indexOf('await callModel'), 'declined before the model call');
    // And the import really does mark them, so this check is not guarding a
    // flag nobody sets.
    assert.match(read('supabase/migrations/20260906160000_the_import_brings_the_conversation.sql'), /jsonb_build_object\('imported', true/);
  });

  test('a message with no words costs nothing', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    const declineAt = slice.indexOf('the client used no words');
    assert.ok(declineAt > 0 && declineAt < slice.indexOf('const runId = await openRun'), 'declined before the run is even opened');
    assert.match(WORKFLOWS, /function theirWordsIn\(/);
  });

  test('§3.2: the contact the thread knows is linked', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /\.select\('id, lead_id, contact_id'\)/);
    assert.match(slice, /p_contact_id: conversation\.contact_id/);
  });

  test('what was STORED is recorded beside what was read', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /storedStartAt: decision\.startAt/);
    assert.match(slice, /dropped: decision\.dropped/);
  });

  test('a refusal is recorded as itself on the run, not as silence', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /acted: false, refusal: decision\.reason/);
    assert.match(slice, /acted: true,\s*\n\s*outcome,/);
  });
});

describe('D2. the door cannot lose the race', () => {
  const LOCKED = read('supabase/migrations/20260916120000_one_request_per_lead_is_held_under_a_lock.sql');

  test('the lead row is locked before its live meetings are counted', () => {
    // Two jobs from two messages by one client, claimed by two overlapping
    // runner invocations: both read no-live-meeting and both insert.
    assert.match(LOCKED, /select l\.\* into v_lead from crm\.leads l where l\.id = p_lead_id for update;/);
    const lock = LOCKED.indexOf('for update;');
    const count = LOCKED.indexOf("m.status in ('requested', 'proposed', 'booked')");
    assert.ok(lock > 0 && count > lock, 'the lock must be taken before the check');
  });

  test('and it is carried forward with exactly one marked edit', () => {
    const body = (sql: string) => sql.slice(sql.indexOf('as $$'), sql.indexOf('$$;'));
    const before = body(read('supabase/migrations/20260914130000_a_client_asks_for_a_meeting.sql'));
    const after = body(LOCKED);
    assert.equal((after.match(/\[G-249 review edit/g) ?? []).length, 1);
    // Everything else byte-identical: regenerating a door from memory is how
    // replace_payment_plan was silently reverted.
    // Everything else byte-identical once the edit's own lines are removed:
    // regenerating a door from memory is how replace_payment_plan was
    // silently reverted.
    const withoutTheEdit = (t: string) =>
      t.split('\n')
        .filter((l) => !l.includes('[G-249 review edit') && !l.trimStart().startsWith('-- makes') && !l.trimStart().startsWith('-- two jobs from') && !l.trimStart().startsWith('-- two messages by') && !l.trimStart().startsWith('-- invocations, both read'))
        .map((l) => l.replace(' for update;', ';'))
        .join('\n');
    assert.equal(withoutTheEdit(after), withoutTheEdit(before));
  });
});

describe('E. the wiring', () => {
  test('it is the fourth reader of an inbound message, under its own job kind', () => {
    assert.deepEqual(SUBSCRIPTIONS['message.received'], [
      'sales:readIntent', 'sales:readQualification', 'sales:summariseThread', 'sales:readMeetingRequest',
    ]);
    assert.equal(HANDLER_JOB_KIND['sales:readMeetingRequest'], 'meeting.request_read');
    assert.match(WORKFLOWS, /AGENT_WORKFLOWS: readonly AgentWorkflow\[\] = \[\s*\n\s*REQUIREMENT_EXTRACT,\s*\n\s*MEETING_REQUEST_READ,/);
  });

  test('and it is NOT a twenty-third message intent', () => {
    // A message can be a price enquiry AND ask for a call; one label cannot
    // carry both, which is why this is a second reading rather than a wider
    // vocabulary for the first.
    const intents = read('src/modules/crm/schema.ts');
    assert.doesNotMatch(intents, /'meeting_request'/, 'the intent vocabulary must not have grown one');
    assert.match(CATALOG, /a message can be a\s*\n\s*\* price enquiry AND ask to meet/);
  });

  test('the module is pure — no clock of its own, no database, no model', () => {
    assert.doesNotMatch(MODULE, /Date\.now\(\)|new Date\(\)(?!\))/, 'the rule takes `now`, so it can be tested against one');
    assert.doesNotMatch(MODULE, /supabase|admin\.|callModel/);
  });
});
