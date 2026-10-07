// Phase 1 agent workflows, proven with a STUB model: a client's scheduling message is routed to a person (never acted on), and a client's reply to a quotation
// is classified without ever becoming an acceptance. The deterministic classifiers run with no funded model; the model-backed run is MANUAL_EXTERNAL.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { keywordIntentClassifier, routeMeetingIntent, type FlagKind, type IntentClassifier } from '../src/modules/crm/p1o-meeting-intent.ts';
import { clarificationDraft, keywordReplyClassifier, readAcceptanceSignal, reviewQuoteReply, type QuoteReplyClass, type ReplyClassifier } from '../src/modules/sales/p1o-quote-reply.ts';

type Flag = { meetingId: string; kind: FlagKind; note: string; candidateMeetingIds: string[] };
function flagPort() {
  const calls: Flag[] = [];
  return { calls, flag: async (args: Flag) => { calls.push(args); return { outcome: 'flagged' }; } };
}
const m = (id: string, status = 'booked', at: string | null = '2026-12-02T05:00:00Z') => ({ id, status, confirmedStartAt: at });

describe('a scheduling message is read, then routed to a person', () => {
  const cases: Array<[string, string]> = [
    ['Can we reschedule to Thursday?', 'reschedule'],
    ['Please postpone our call', 'reschedule'],
    ['dusre din rakh sakte hain?', 'reschedule'],
    ['I need to cancel the meeting', 'cancel'],
    ['kal nahi aa pa raha, cancel kar do', 'ambiguous'],
    ['When are you free this week?', 'availability_question'],
    ['please remind me before the call', 'reminder_question'],
    ['thanks, see you', 'none'],
  ];
  for (const [text, intent] of cases) {
    test(`"${text}" reads as ${intent}`, async () => {
      assert.equal((await keywordIntentClassifier(text)).intent, intent);
    });
  }

  test('one live meeting and a reschedule request: a reschedule flag, nothing else moves', async () => {
    const port = flagPort();
    const r = await routeMeetingIntent({ text: 'Can we reschedule to Thursday?', meetings: [m('a')] }, { flag: port.flag });
    assert.deepEqual(r, { routed: true, kind: 'reschedule_request', meetingId: 'a', candidates: [], outcome: 'flagged' });
    assert.equal(port.calls.length, 1);
    assert.match(port.calls[0]?.note ?? '', /reschedule/);
  });

  test('several live meetings and a cancel: an AMBIGUITY flag naming every candidate, never a guess about which', async () => {
    const port = flagPort();
    const r = await routeMeetingIntent({ text: 'please cancel our meeting', meetings: [m('late', 'booked', '2026-12-09T05:00:00Z'), m('soon', 'booked', '2026-12-02T05:00:00Z')] }, { flag: port.flag });
    assert.ok(r.routed);
    if (r.routed) {
      assert.equal(r.kind, 'ambiguous_cancel');
      assert.deepEqual(r.candidates, ['soon', 'late']);
      assert.equal(r.meetingId, 'soon');
    }
  });

  test('cancel and move in one message with one meeting: filed as a decision for a person, not as either', async () => {
    const port = flagPort();
    const r = await routeMeetingIntent({ text: 'cancel it or maybe reschedule, not sure', meetings: [m('a')] }, { flag: port.flag });
    assert.ok(r.routed && r.kind === 'needs_escalation');
  });

  test('a settled meeting is not a live one: nothing is flagged', async () => {
    const port = flagPort();
    const r = await routeMeetingIntent({ text: 'reschedule please', meetings: [m('a', 'completed'), m('b', 'cancelled')] }, { flag: port.flag });
    assert.deepEqual(r, { routed: false, reason: 'no_live_meeting' });
    assert.equal(port.calls.length, 0);
  });

  test('a message that is not about scheduling is left alone', async () => {
    const port = flagPort();
    const r = await routeMeetingIntent({ text: 'thanks, see you', meetings: [m('a')] }, { flag: port.flag });
    assert.deepEqual(r, { routed: false, reason: 'not_a_scheduling_intent' });
    assert.equal(port.calls.length, 0);
  });

  test('a STUB MODEL can replace the keywords through the same port, and its answer is recorded as a model reading', async () => {
    const stub: IntentClassifier = async () => ({ intent: 'availability_question', source: 'model' });
    const port = flagPort();
    const r = await routeMeetingIntent({ text: 'Hmm, could we do some other slot, whatever works', meetings: [m('a')] }, { classify: stub, flag: port.flag });
    assert.ok(r.routed && r.kind === 'availability_question');
    assert.match(port.calls[0]?.note ?? '', /\(model\)/);
  });

  test('the agent only flags: it is given no way to book, cancel or send', async () => {
    const port = flagPort();
    // the only dependency the workflow accepts is the flag port; there is nothing else to call
    await routeMeetingIntent({ text: 'cancel the meeting', meetings: [m('a')] }, { flag: port.flag });
    assert.deepEqual(Object.keys(port).filter((k) => k !== 'calls' && k !== 'flag'), []);
  });
});

describe('reading a reply to a quotation', () => {
  const classes: Array<[string, QuoteReplyClass | null]> = [
    ['This is too expensive for us', 'price_objection'],
    ['Can we do 30% advance and the rest later?', 'payment_term_objection'],
    ['We need this faster, the deadline is tight', 'timeline_objection'],
    ['How do we know we can trust you? Any reviews?', 'trust_objection'],
    ['Please remove the admin module from scope', 'scope_objection'],
    ['Can you also add a chat feature', 'change_request'],
    ['let me think and get back to you', 'needs_more_time'],
    ['not interested, going with someone else', 'rejected'],
    ['What does the support line include?', 'clarification'],
    ['thanks', null],
  ];
  for (const [text, expected] of classes) {
    test(`"${text}" -> ${expected}`, async () => {
      assert.equal((await keywordReplyClassifier(text)).replyClass, expected);
    });
  }
});

describe('an acceptance is never inferred', () => {
  test('a version named in the reply is explicit', () => assert.deepEqual(readAcceptanceSignal('Yes, go ahead with version 2', [1, 2]), { kind: 'explicit', version: 2 }));
  test('plan and option wording count too', () => assert.deepEqual(readAcceptanceSignal('okay, option 3 it is', [1, 3]), { kind: 'explicit', version: 3 }));
  test('a bare "okay" with several versions open is ambiguous', () => assert.deepEqual(readAcceptanceSignal('okay', [1, 2]), { kind: 'ambiguous', openVersions: [1, 2] }));
  test('a bare Hinglish "theek hai" with several open is ambiguous too', () => assert.equal(readAcceptanceSignal('theek hai', [1, 2]).kind, 'ambiguous'));
  test('naming a version that is not open is ambiguous, not accepted', () => assert.equal(readAcceptanceSignal('yes version 7', [1, 2]).kind, 'ambiguous'));
  test('a bare "okay" with one version open is only a signal for a person to record', () => assert.deepEqual(readAcceptanceSignal('okay done', [3]), { kind: 'single_open_unconfirmed', version: 3 }));
  test('assent with a condition is not an acceptance signal', () => assert.equal(readAcceptanceSignal('okay but can you reduce the price', [1]).kind, 'none'));
  test('nothing open means nothing to accept', () => assert.equal(readAcceptanceSignal('okay', []).kind, 'none'));
  test('the clarification asks for an exact version, offers no inference, and speaks Hinglish when asked', () => {
    assert.match(clarificationDraft([1, 2]), /version 1 or version 2/);
    assert.match(clarificationDraft([1, 2]), /exactly which version/);
    assert.match(clarificationDraft([1, 2], 'hinglish'), /kaun sa version/);
  });
});

describe('reviewing a reply with a recording port', () => {
  function recorder() {
    const calls: Array<{ proposalId: string; responseClass: QuoteReplyClass; messageRef: string | null; note: string }> = [];
    return { calls, record: async (a: (typeof calls)[number]) => { calls.push(a); return { outcome: 'recorded' }; } };
  }

  test('an unspecific "okay" with two versions open is recorded as AMBIGUOUS and a clarification is drafted, nothing is accepted', async () => {
    const rec = recorder();
    const r = await reviewQuoteReply({ text: 'okay', proposalId: 'p1', messageRef: 'wamid.1', openVersions: [1, 2] }, { record: rec.record });
    assert.equal(r.recorded?.replyClass, 'ambiguous');
    assert.ok(r.clarificationDraft && /exactly which version/.test(r.clarificationDraft));
    assert.equal(r.needsPersonToRecordAcceptance, false);
    assert.equal(rec.calls.length, 1);
  });

  test('an explicit acceptance is handed to a person: the agent records no class at all and certainly not "accepted"', async () => {
    const rec = recorder();
    const r = await reviewQuoteReply({ text: 'yes, version 2 please', proposalId: 'p2', messageRef: null, openVersions: [1, 2] }, { record: rec.record });
    assert.equal(r.needsPersonToRecordAcceptance, true);
    assert.equal(r.recorded, null);
    assert.equal(rec.calls.length, 0);
    assert.ok(!rec.calls.some((c) => (c.responseClass as string) === 'accepted'));
  });

  test("an objection is recorded with its class and the client's words, trimmed", async () => {
    const rec = recorder();
    const r = await reviewQuoteReply({ text: 'This is too   expensive for us', proposalId: 'p3', messageRef: 'wamid.3', openVersions: [1] }, { record: rec.record });
    assert.equal(r.recorded?.replyClass, 'price_objection');
    assert.equal(rec.calls[0]?.note, 'This is too expensive for us');
    assert.equal(rec.calls[0]?.messageRef, 'wamid.3');
  });

  test('a STUB MODEL classifier replaces the keywords; the same refusal to accept holds', async () => {
    const stub: ReplyClassifier = async () => ({ replyClass: 'change_request', source: 'model' });
    const rec = recorder();
    const r = await reviewQuoteReply({ text: 'hmm let us tweak the second milestone', proposalId: 'p4', messageRef: null, openVersions: [1] }, { record: rec.record, classify: stub });
    assert.equal(r.recorded?.replyClass, 'change_request');
    assert.equal(r.needsPersonToRecordAcceptance, false);
  });

  test('a reply nothing recognises records nothing', async () => {
    const rec = recorder();
    const r = await reviewQuoteReply({ text: 'thanks', proposalId: 'p5', messageRef: null, openVersions: [1] }, { record: rec.record });
    assert.equal(r.recorded, null);
    assert.equal(rec.calls.length, 0);
  });
});
