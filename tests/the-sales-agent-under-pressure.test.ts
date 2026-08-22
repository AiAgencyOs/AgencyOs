import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { clientReplySchema, QUALIFICATION_AREAS } from '../src/modules/crm/schema.ts';
import { sqlCode } from './_code-only.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

/**
 * The Sales Agent, under pressure.
 *
 * The mandate of 2026-08-23 asks for a sales agent that survives difficult
 * customers rather than one that answers easy ones, and it names thirty
 * failure modes and about twenty adversarial openings. This file is the half
 * of that which can be settled without a model: **what the system will let a
 * reply be**, and **what the agent is given to reason from**.
 *
 * The other half — whether the words are any good — cannot be asserted here
 * and is not pretended at. It needs a real conversation, and the report says
 * so.
 *
 * The distinction matters because it is the one this repository keeps getting
 * wrong in the other direction: a green test that proves a model was called is
 * not a test that the sales agent works.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const MIGRATION = read('supabase/migrations/20260823140000_a_salesperson_who_asks_for_help.sql');
const REPLY = RUNNER_SOURCE.slice(
  RUNNER_SOURCE.indexOf('const REPLY_PROMPT'),
  RUNNER_SOURCE.indexOf('async function hear'),
);

describe('A. what a reply may never contain, whatever it is asked', () => {
  const reply = (text: string) => clientReplySchema.safeParse({ reply: text, handToHuman: null });

  /**
   * ADM-22 leaves every price to a human, and ADM-61 §5 makes inventing one
   * something no agent may do at any level. The mandate's PART 12 and PART 21
   * push at it from every angle a client would.
   */
  test('no price survives, in any of the shapes a client would provoke', () => {
    for (const provoked of [
      'It will be around ₹50,000 for this scope.',
      'We can do it for 50000 rupees.',
      'Roughly 2 lakh, sir.',
      'It comes to about 80k.',
      'Budget approximately $3,000.',
      'That would be Rs. 40,000.',
      'Around 1.5 crore for the full platform.',
      'USD 5000 is the usual range.',
      'I can give you 20% discount.',
      'Final price 35,000 INR.',
    ]) {
      assert.equal(reply(provoked).success, false, `a reply must not carry: ${provoked}`);
    }
  });

  /**
   * The one the schema did not hold, found by this file.
   *
   * "I can give you 20% discount" carries no currency and no amount word, so
   * both price regexes let it through. It only ever failed at the ROW, where
   * `crm.states_a_price` catches it — so a client never saw one, and the job
   * composed it, validated it, was refused, and retried into the same refusal.
   * A rule held by two layers and tested through one.
   */
  test('a discount is refused here too, not only at the row', () => {
    for (const offered of [
      'I can give you 20% discount.',
      'We can do 10 % off for you.',
      'A discount of 15 is possible.',
      'Main aapko 25% less kar deta hoon.',
    ]) {
      assert.equal(reply(offered).success, false, `a reply must not carry: ${offered}`);
    }
  });

  test('but a percentage that is not a discount still passes — "50% complete"', () => {
    // The row guard's own exemption, restated: blocking every percentage would
    // teach whoever hit it to route around the guard.
    assert.equal(reply('Design 50% complete hai, next week tak ho jayega.').success, true);
    assert.equal(reply('Around 30% of the screens are done.').success, true);
  });

  test('and the sentences a salesperson SHOULD be able to write still pass', () => {
    for (const legitimate of [
      'Price scope pe depend karega — pehle ye batao ki app mein kya-kya hona chahiye.',
      'Hum stage by stage kaam karte hain, har stage aap approve karte ho.',
      'Ye 50% complete hai abhi.',
      'Achha, samajh gaya. Android aur iOS dono ke liye sochte hain.',
      'Main ek colleague ko bolta hoon, wo aapko proper figure denge.',
    ]) {
      assert.equal(reply(legitimate).success, true, `a reply must be allowed to say: ${legitimate}`);
    }
  });

  test('emoji spam is refused — the mandate’s PART 9', () => {
    assert.equal(reply('Hi 👋😊 Great! 🚀').success, false);
    assert.equal(reply('Achha samajh gaya 😊').success, true);
    assert.equal(reply('Achha samajh gaya.').success, true);
  });

  test('a wall of text is refused at the point it stops being a WhatsApp message', () => {
    assert.equal(reply('a'.repeat(1201)).success, false);
    assert.equal(reply('a'.repeat(1200)).success, true);
  });

  test('an empty reply is refused — saying nothing is not an answer', () => {
    assert.equal(reply('   ').success, false);
  });
});

describe('B. asking for a person, which nothing could do before', () => {
  const code = sqlCode(MIGRATION);

  test('the reply can ask, with a reason somebody can act on', () => {
    assert.equal(
      clientReplySchema.safeParse({
        reply: 'Bilkul, main abhi ek colleague ko bolta hoon.',
        handToHuman: 'the client asked to speak to a person',
      }).success,
      true,
    );
    // A reason is not optional. "Escalated" with no words is a stopped
    // conversation nobody can pick up.
    assert.equal(
      clientReplySchema.safeParse({ reply: 'ok', handToHuman: '  ' }).success,
      false,
    );
  });

  /**
   * The absence that makes it safe. An agent that could resume itself after
   * escalating would be an agent deciding that whatever it escalated no longer
   * matters.
   */
  test('nothing in this system can un-pause a conversation', () => {
    assert.match(code, /create or replace function crm\.hand_conversation_to_a_person/);
    // The only writer sets it and never clears it.
    const body = code.slice(code.indexOf('function crm.hand_conversation_to_a_person'));
    const fn = body.slice(0, body.indexOf('$$;'));
    assert.match(fn, /agent_paused_at\s*=\s*now\(\)/);
    assert.doesNotMatch(fn, /agent_paused_at\s*=\s*null/);
    // And nowhere else in the runner clears it either.
    assert.doesNotMatch(RUNNER_SOURCE, /agent_paused_at:\s*null/);
  });

  test('a paused thread stops the agent answering, at the row', () => {
    const emit = code.slice(code.lastIndexOf('create or replace function crm.emit_reply_due'));
    assert.match(emit.slice(0, emit.indexOf('$$;')), /agent_paused_at is not null/);
  });

  test('the pause and its reason travel together — neither alone means anything', () => {
    assert.match(code, /\(agent_paused_at is null\) = \(agent_paused_reason is null\)/);
  });

  test('the escalation happens AFTER the send, so the client hears it', () => {
    const handled = REPLY.indexOf('if (validated.data.handToHuman)');
    const sent = REPLY.indexOf('send_outbound_message');
    assert.ok(sent > 0 && handled > sent, 'pausing before sending would swallow the escalation itself');
  });

  test('the agent may not reach the pause by any route but the one function', () => {
    assert.match(code, /revoke all on function crm\.hand_conversation_to_a_person\(uuid, text\) from public/);
    assert.match(code, /grant execute on function crm\.hand_conversation_to_a_person\(uuid, text\) to service_role/);
  });
});

describe('C. the context Doc 09 §32 says the agent must have', () => {
  /**
   * §32 lists thirteen. Before this change the reply had two and a half, and
   * that single fact explains most of what reads as the agent "not being a
   * salesperson": it asked what the requirements already recorded, never
   * mentioned a concern raised two messages earlier, and kept discovering long
   * after a quotation was on the table.
   */
  test('every section of the sales file is actually assembled', () => {
    for (const [what, needle] of [
      ['lead status', /Where this lead stands:/],
      ['requirements', /What we have written down so far/],
      ['objections', /Concerns they have raised:/],
      ['quote versions', /A quotation \(v\$\{sent\.version\}\) has already gone to them/],
      ['follow-up history', /We have already followed up/],
      ['portfolio', /There is NO approved past work to show/],
    ] as const) {
      assert.match(REPLY, needle, `the sales file must carry ${what}`);
    }
  });

  test('and each is read from the table that holds it', () => {
    for (const table of ['requirement_versions', 'objections', 'proposals', 'follow_up_sequences', 'portfolio_items']) {
      assert.match(REPLY, new RegExp(`from\\('${table}'\\)`), `${table} must be read`);
    }
  });

  /**
   * The file changes how the conversation goes, and this is the sharpest of
   * those changes: a client holding a quotation is deciding, not being
   * discovered. The mandate's PART 16.
   */
  test('a sent quotation stops discovery rather than adding to it', () => {
    assert.match(REPLY, /do not restart discovery/i);
  });

  test('the file carries no amount — the cheapest way not to say a number', () => {
    const file = REPLY.slice(REPLY.indexOf('function salesFileFor'), REPLY.indexOf('const CLIENT_REPLY'));
    for (const money of ['total_minor', 'subtotal_minor', 'discount_minor', 'currency', 'value_minor']) {
      assert.doesNotMatch(file, new RegExp(money), `the sales file must not read ${money}`);
    }
  });

  /**
   * ADM-12: samples come only from the Admin's list, and the list is empty
   * until they fill it. Saying "we can show you our work" when there is none
   * to show is a promise the agency cannot keep.
   */
  test('with an empty portfolio the agent is told NOT to offer samples', () => {
    assert.match(REPLY, /Do not offer samples, demos or a portfolio/);
  });

  /**
   * The assertion this section did not have, found by red-proving it.
   *
   * Deleting `salesFile` from the model's input left all six section checks
   * green: they proved the file was BUILT and never that it was HANDED OVER.
   * A file assembled and dropped is the same as no file at all.
   */
  test('and it actually reaches the model, not just the function that builds it', () => {
    const call = REPLY.slice(REPLY.indexOf('const call = await callModel'));
    const content = call.slice(0, call.indexOf('runId,'));
    assert.match(content, /salesFile/, 'the sales file must be part of what the model is given');
  });

  test('a poorer context never costs the reply — every read is best-effort', () => {
    const gather = REPLY.slice(REPLY.indexOf('const [lead, requirement'), REPLY.indexOf('const salesFile'));
    assert.doesNotMatch(gather, /if \(.*Error\)/, 'a failed context read must not abort the reply');
  });
});

describe('D. the failure modes the mandate names, that a prompt can answer', () => {
  const prompt = REPLY.slice(0, REPLY.indexOf('const CLIENT_REPLY'));

  test('#27 the client asks for a human', () => {
    assert.match(prompt, /HAND OVER when they ask for a human/);
  });

  test('#28 and #29 the agent gets defensive, or argues', () => {
    assert.match(prompt, /DO NOT ARGUE/);
    assert.match(prompt, /never compete on price/);
  });

  test('"are you AI?" is answered honestly rather than dodged', () => {
    assert.match(prompt, /tell them the truth plainly/);
    assert.match(prompt, /Do not deny it/);
  });

  test('#4 budget is not the opening question, and not a forbidden one either', () => {
    assert.match(prompt, /BUDGET is not an opening question and not a forbidden one/);
    assert.match(prompt, /do not ask twice/);
  });

  test('#10 and #11 buying signals are named, and end discovery', () => {
    assert.match(prompt, /WHEN THEY ARE READY, STOP DISCOVERING/);
    assert.match(prompt, /Do not go back to discovery questions/);
  });

  test('value selling — the business, not the feature list', () => {
    assert.match(prompt, /WHY, NOT ONLY WHAT/);
    assert.match(prompt, /not that you took an order/);
  });

  test('#5 and #6 what the thread already answered is never asked again', () => {
    assert.match(prompt, /Never ask what the thread already answered/);
    assert.match(REPLY, /You already know this\. Do not ask it again\./);
  });

  test('the sixteen qualification areas are Doc 09 §9’s, not an invented list', () => {
    assert.equal(QUALIFICATION_AREAS.length, 16);
    for (const area of ['budget', 'decision_maker', 'trust_concerns', 'payment_expectations']) {
      assert.ok((QUALIFICATION_AREAS as readonly string[]).includes(area));
    }
  });

  test('and they are context rather than a checklist — Doc 09 §9', () => {
    assert.match(prompt, /That is context, not a checklist/);
  });
});
