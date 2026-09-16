import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import {
  SCHEDULING_INTENTS,
  SCHEDULING_REFUSALS,
  decideScheduling,
  localDateLine,
  schedulingRequestSchema,
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
      const d = decideScheduling(base({ intent }), NOW);
      assert.equal(d.act, 'none', `${intent} must not create a meeting`);
      if (d.act === 'none') {
        assert.equal(d.reason, 'other_intent');
        assert.equal(d.detail, intent, 'the log says which one the client actually asked for');
      }
    }
    // Not scheduling at all is its own answer, not the same one.
    const none = decideScheduling(base({ intent: 'none' }), NOW);
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
    const d = decideScheduling(base({ explicit: false }), NOW);
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
    const d = decideScheduling(base({ intent: 'meeting', mode: 'video_meeting' }), NOW);
    assert.ok(d.act === 'request' && d.mode === 'video_meeting');
  });

  test('a call with no mode is a call; a meeting with no mode is `other`, not a guess', () => {
    const call = decideScheduling(base({ intent: 'call', mode: null }), NOW);
    assert.ok(call.act === 'request' && call.mode === 'call', 'they said call in the intent');
    const meeting = decideScheduling(base({ intent: 'meeting', mode: null }), NOW);
    assert.ok(meeting.act === 'request' && meeting.mode === 'other', '"meeting" does not say video or in person');
  });

  test('§4.2: a time that resolves to the PAST drops the time, never the request', () => {
    const d = decideScheduling(base({ startAt: '2026-09-15T10:00:00.000Z' }), NOW);
    // The client still asked to meet. What is dropped is the hour, not the ask.
    assert.ok(d.act === 'request', 'a past time must not swallow the request');
    if (d.act === 'request') {
      assert.equal(d.startAt, null);
      assert.equal(d.windowEnd, null);
    }
  });

  test('§4.3: a range is carried whole, and a backwards one loses only its end', () => {
    const range = decideScheduling(base({ startAt: '2026-09-17T12:30:00.000Z', windowEnd: '2026-09-17T14:30:00.000Z' }), NOW);
    assert.ok(range.act === 'request' && range.startAt === '2026-09-17T12:30:00.000Z' && range.windowEnd === '2026-09-17T14:30:00.000Z');
    const backwards = decideScheduling(base({ startAt: '2026-09-17T14:30:00.000Z', windowEnd: '2026-09-17T12:30:00.000Z' }), NOW);
    assert.ok(backwards.act === 'request' && backwards.startAt === '2026-09-17T14:30:00.000Z' && backwards.windowEnd === null);
  });

  test('a window with no start is not sent — the door refuses it by name', () => {
    const d = decideScheduling(base({ startAt: null, windowEnd: '2026-09-17T14:30:00.000Z' }), NOW);
    assert.ok(d.act === 'request' && d.startAt === null && d.windowEnd === null);
  });

  test('an unparseable time is null, never NaN', () => {
    const d = decideScheduling(base({ startAt: 'tomorrow-ish' }), NOW);
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

  test('a refusal is recorded as itself on the run, not as silence', () => {
    const slice = WORKFLOWS.slice(WORKFLOWS.indexOf('const MEETING_REQUEST_READ'), WORKFLOWS.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(slice, /acted: false, refusal: decision\.reason/);
    assert.match(slice, /acted: true, outcome/);
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
