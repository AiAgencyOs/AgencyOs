import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SITUATIONS } from '../src/modules/crm/follow-up-situations.ts';
import { escalationReason } from '../src/modules/crm/follow-up-worker.ts';

/**
 * An exhausted follow-up sequence reaches a person — G-246.
 *
 * ADM-69 gives every situation an escalation target and ADM-103 restates it in
 * the owner's own words: *maximum two, then the thread goes to a person*. What
 * happened was `status = 'escalated'` on a row and nothing else — no event, no
 * pause, nobody told. Asserted here: that somebody is told, that they are told
 * BEFORE the row says it happened, and that the thread nobody may pause is not
 * paused.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKER = read('src/modules/crm/follow-up-worker.ts');
/** The escalate function alone, so an assertion is about it rather than the file. */
const ESCALATE = WORKER.slice(WORKER.indexOf('async function escalate('), WORKER.indexOf('type SendResult'));

describe('A. somebody is told, and told first', () => {
  test('a client thread is handed to a person before the row records the escalation', () => {
    const hand = ESCALATE.indexOf('hand_conversation_to_a_person');
    const record = ESCALATE.indexOf('escalate_follow_up_sequence');
    assert.ok(hand > 0 && record > 0, 'both calls are present');
    assert.ok(hand < record, 'the telling must come first — only the winner of the status flip ever acts');
  });

  test('a handover that fails does NOT escalate, so the next tick tries again', () => {
    assert.match(ESCALATE, /if \(handError\) \{[\s\S]*?return false;/);
    // And it says so where somebody reading the log will find it.
    assert.match(ESCALATE, /could not hand the thread to a person/);
  });

  test('the pause is the handover: nothing else is invented to carry it', () => {
    // `agent_paused_at` has a trigger that emits conversation.escalated, and
    // the announcer already delivers that. A second notifier here would be a
    // second way for the owner to hear the same thing.
    assert.doesNotMatch(ESCALATE, /emit_event|send_outbound_message|internalChannel/);
  });
});

describe('B. the thread that must not be paused is not', () => {
  test('only a client-consent situation with a thread is handed over', () => {
    assert.match(ESCALATE, /situation\.audience === 'client_consent' && seq\.conversation_id/);
  });

  test('which is what protects the internal approval channel', () => {
    // `pending_approval` is ADM-69's one internal situation: its conversation
    // IS the internal group being chased. Pausing it would silence the thing
    // the reminder exists to chase.
    const internal = SITUATIONS.filter((s) => s.audience === 'internal').map((s) => s.key);
    assert.deepEqual(internal, ['pending_approval'], 'a second internal situation needs this decision re-made');
  });
});

describe('C. what the person is handed', () => {
  test('it names the situation, counts the attempts and says the agent has stopped', () => {
    assert.equal(
      escalationReason('Missed meeting', 2),
      'Missed meeting: the client was followed up 2 times and has not replied. The agent has stopped here — the next message is yours.',
    );
    assert.match(escalationReason('Inactive lead', 1), /followed up once and/, 'one is not "1 times"');
  });

  test('and fits the 300 characters the row stores, for every situation', () => {
    for (const s of SITUATIONS) {
      for (const attempts of [1, 7]) {
        const reason = escalationReason(s.name, attempts);
        assert.ok(reason.length <= 300, `${s.key} at ${attempts}: ${reason.length} chars`);
        assert.ok(reason.trim().length > 0, 'the door refuses an empty reason');
      }
    }
  });

  test('it does not say "escalated" — a person reads what happened, not the queue’s word for it', () => {
    assert.doesNotMatch(escalationReason('Missed meeting', 2), /escalat/i);
  });
});

describe('D. both doors into escalation go through it', () => {
  test('the send that used the last attempt, and the sweep that found none left', () => {
    // Two call sites, and the first version of this fix changed one of them.
    const calls = [...WORKER.matchAll(/await escalate\(admin, /g)];
    assert.equal(calls.length, 2, `${calls.length} call sites — a third needs the same argument`);
    for (const call of calls) {
      const after = WORKER.slice(call.index ?? 0, (call.index ?? 0) + 200);
      assert.doesNotMatch(after, /escalate\(admin, seq\.sequence_id\)/, 'an id alone cannot tell anybody');
    }
    // The send path counts the attempt that just went, not the stale column.
    assert.match(WORKER, /escalate\(admin, \{ \.\.\.seq, attempts_sent: attempt \}/);
  });
});
