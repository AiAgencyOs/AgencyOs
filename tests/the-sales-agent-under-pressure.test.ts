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

/**
 * E. the other half of asking for help.
 *
 * The escalation shipped alone: the agent paused the thread, the client was
 * told somebody was coming, and `agent_paused_at` appeared nowhere outside the
 * migration that created it. A conversation waiting for a person who does not
 * know they are waited for is worse than no escalation at all — before it the
 * agent answered badly, after it the client sat in a silence AgencyOS made.
 *
 * Found by checking rather than assumed.
 */
describe('E. somebody is told, and somebody can end it', () => {
  const HANDLERS = read('src/modules/crm/handlers.ts');
  const MIGRATION2 = sqlCode(read('supabase/migrations/20260823160000_a_thread_that_waits_for_somebody.sql'));

  test('pausing a thread emits an event, on the transition only', () => {
    assert.match(MIGRATION2, /old\.agent_paused_at is null and new\.agent_paused_at is not null/);
    assert.match(MIGRATION2, /create trigger emit_conversation_escalated/);
  });

  test('and it reaches the internal group through the announcer that already existed', () => {
    // A second notifier would be a second thing to keep in step, and the one
    // that drifts is the one nobody remembers exists.
    const handler = HANDLERS.slice(HANDLERS.indexOf('export async function handleConversationEscalated'));
    assert.match(handler, /kind', 'internal_group'/);
    assert.match(handler, /rpc\('send_outbound_message'/);
    assert.match(handler, /p_external_ref: `escalated:\$\{event\.conversation_id\}`/);
  });

  test('the message says the three things a person needs and no more', async () => {
    const { escalationAnnouncementFor } = await import('../src/modules/crm/schema.ts');
    const note = escalationAnnouncementFor({
      who: 'Priya Raman · +919876543210',
      reason: 'the client asked to speak to a person',
    });
    assert.match(note, /A client is waiting for a person\./);
    assert.match(note, /Priya Raman/);
    assert.match(note, /the client asked to speak to a person/);
    assert.match(note, /will not start again until somebody puts it back/);
    // No link: the production domain is one of ADM-60's deferred facts, and a
    // URL built from an unset NEXT_PUBLIC_APP_URL points nowhere.
    assert.doesNotMatch(note, /https?:\/\//);
  });

  test('an unnamed contact still gets announced — the point is that somebody waits', async () => {
    const { escalationAnnouncementFor } = await import('../src/modules/crm/schema.ts');
    assert.match(escalationAnnouncementFor({ who: null, reason: 'x' }), /an unnamed contact/);
  });

  /**
   * The asymmetry is the design. The pause takes no identity because the agent
   * has none; the resume refuses a caller without one — including the service
   * role, which is refused by the grant before the check is even reached.
   */
  test('only a person can put the agent back — not the service role, not the agent', () => {
    assert.match(MIGRATION2, /only a person may put the agent back/);
    assert.match(MIGRATION2, /revoke all on function crm\.resume_agent_replies\(uuid\) from public/);
    assert.match(MIGRATION2, /grant execute on function crm\.resume_agent_replies\(uuid\) to authenticated/);
    assert.doesNotMatch(MIGRATION2, /resume_agent_replies\(uuid\) to service_role/);
  });

  test('and it is pinned to the caller’s own organization, by hand', () => {
    const fn = MIGRATION2.slice(MIGRATION2.indexOf('function crm.resume_agent_replies'));
    assert.match(fn.slice(0, fn.indexOf('$$;')), /organization_id = \(select core\.current_organization_id\(\)\)/);
  });

  test('the thread that is waiting says so above itself, not inside the scroll', () => {
    const page = read('app/(internal)/leads/[leadId]/page.tsx');
    const banner = page.indexOf('<WaitingForSomebody');
    const canvas = page.indexOf('<ChatCanvas>', banner);
    assert.ok(banner > 0, 'the lead page must render the banner');
    assert.ok(canvas > banner, 'it must sit above the thread, not inside it');
  });
});

/**
 * F. the quotation, where the agent's half ends.
 *
 * Doc 09 §15: *"Quote generation is assisted by AI but governed by the Policy
 * Engine."* The loop itself has existed since G-011 — I said otherwise in an
 * earlier report and was wrong. What was missing is the assistance, and the
 * only interesting question about it is what the assistance may not do.
 */
describe('F. the scope is the agent’s, the price is not', () => {
  const MIGRATION3 = sqlCode(read('supabase/migrations/20260823170000_the_scope_is_the_agents_the_price_is_not.sql'));
  const WORKFLOW = RUNNER_SOURCE.slice(RUNNER_SOURCE.indexOf('const QUOTATION_PROMPT'));

  test('there is no field a price could arrive in', async () => {
    const { quotationScopeSchema } = await import('../src/modules/sales/schema.ts');
    const scope = { title: 'A delivery app', items: [{ description: 'Customer app' }], summary: 'x' };
    assert.equal(quotationScopeSchema.safeParse(scope).success, true);
    for (const field of ['price', 'amount', 'unitPriceMinor', 'total', 'discount', 'timeline', 'validUntil']) {
      assert.equal(
        quotationScopeSchema.safeParse({ ...scope, [field]: 1 }).success,
        false,
        `${field} must not be accepted`,
      );
    }
  });

  test('and none is passed when the lines are written', () => {
    const write = WORKFLOW.slice(WORKFLOW.indexOf("rpc('add_proposal_item'"));
    const call = write.slice(0, write.indexOf('});'));
    assert.doesNotMatch(call, /p_unit_price_minor/, 'the workflow must not pass a price');
    assert.match(call, /p_description: item\.description/);
  });

  /**
   * Two layers for one rule, because this is the surface where an amount would
   * end up in front of a client with the agency's name on it.
   */
  test('the row refuses one anyway, from a caller nobody can name', () => {
    assert.match(MIGRATION3, /create trigger refuse_priced_by_nobody/);
    const fn = MIGRATION3.slice(MIGRATION3.indexOf('function sales.refuse_priced_by_nobody'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    assert.match(body, /\(select auth\.uid\(\)\) is null/);
    assert.match(body, /p\.generated_by_run_id is not null/);
  });

  test('a draft, never a send — ADM-07 puts a person between them', () => {
    assert.match(WORKFLOW.slice(0, WORKFLOW.indexOf('async run')), /workClass: 'draft'/);
    const body = WORKFLOW.slice(0, WORKFLOW.indexOf('\n};'));
    for (const forbidden of ['send_proposal', 'submit_proposal', 'set_proposal_pricing']) {
      assert.doesNotMatch(body, new RegExp(forbidden), `the agent must not call ${forbidden}`);
    }
  });

  test('only confirmed requirements — quoting a proposal would be quoting itself', () => {
    assert.match(WORKFLOW, /version\.status !== 'accepted'/);
  });

  test('a lead with no open deal is left alone rather than given one', () => {
    const body = WORKFLOW.slice(0, WORKFLOW.indexOf('\n};'));
    assert.match(body, /this lead has no open deal to quote against/);
    // Opening a deal is a sales act with an owner and a pipeline position.
    assert.doesNotMatch(body, /from\('opportunities'\)[\s\S]{0,200}\.insert/);
  });

  test('and who drafted it is recorded, on a column that existed for years', () => {
    assert.match(WORKFLOW, /p_generated_by_run_id: runId/);
    assert.match(MIGRATION3, /generated_by_run_id\s*\)\s*values/);
  });

  /**
   * The carry-forward that was not one.
   *
   * The first version of this migration retyped `draft_proposal` from a
   * reading of its first hundred lines and silently dropped everything after
   * them — the supersede of the previous version, the cancellation of its
   * pending approval, the `superseded` return column, and `security invoker`.
   * Seven checks in `verify-quotations` caught it. D16, again.
   */
  test('draft_proposal kept everything it did before', () => {
    const fn = MIGRATION3.slice(MIGRATION3.indexOf('create or replace function sales.draft_proposal'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    assert.match(body, /security invoker/);
    assert.match(body, /status = 'superseded'/);
    assert.match(body, /approvals\.cancel_request/);
    assert.match(body, /superseded\s+uuid/);
  });
});

/**
 * G. a follow-up that remembers the conversation — the brief's §17.
 *
 * §17 gives the bad example and the good one:
 *
 *   Bad:  "Hello sir, any update?"
 *   Good: "Hi sir, kal jo app ke booking flow ke baare mein baat hui thi,
 *          uska ek point clear karna tha..."
 *
 * The composer could only ever write the first, and not because of the prompt.
 * It was given a situation key, a language tag and a handful of durable
 * memories — and from those the only honest message IS "any update?". A memory
 * is what the client told us once; a transcript is what we were last saying.
 */
describe('G. the follow-up is written from the conversation, not from a tag', () => {
  const DRAFT = RUNNER_SOURCE.slice(
    RUNNER_SOURCE.indexOf('const FOLLOW_UP_CONTEXT_MESSAGES'),
    RUNNER_SOURCE.indexOf('const CLIENT_REPLY'),
  );

  test('the end of the thread is read, and it is the END rather than all of it', () => {
    assert.match(DRAFT, /const FOLLOW_UP_CONTEXT_MESSAGES = \d+/);
    const bound = Number(/const FOLLOW_UP_CONTEXT_MESSAGES = (\d+)/.exec(DRAFT)?.[1] ?? 0);
    assert.ok(bound > 0 && bound <= 20, `a nudge is written from the last exchange, not forty: ${bound}`);
    assert.match(DRAFT, /\.order\('seq', \{ ascending: false \}\)/);
    assert.match(DRAFT, /\.limit\(FOLLOW_UP_CONTEXT_MESSAGES\)/);
  });

  test('and put back in the order they were said', () => {
    assert.match(DRAFT, /transcriptForModel\(\[\.\.\.\(tail \?\? \[\]\)\]\.reverse\(\)\)/);
  });

  test('it actually reaches the model — the half a built context loses', () => {
    const call = DRAFT.slice(DRAFT.indexOf('const call = await callModel'));
    assert.match(call.slice(0, call.indexOf('runId,')), /How the conversation ended/);
  });

  test('the prompt refuses the sentence §17 names as bad', () => {
    for (const empty of ['any update', 'just following up', 'checking in']) {
      assert.ok(DRAFT.includes(empty), `the prompt must name "${empty}" as forbidden`);
    }
    assert.match(DRAFT, /NEVER "any update\?"/);
  });

  test('and refuses a manufactured memory when the thread gives nothing', () => {
    // The failure mode of "always reference the conversation" is inventing one.
    assert.match(DRAFT, /a plain question beats a manufactured memory/);
    assert.match(DRAFT, /There is no conversation to draw on/);
  });

  test('no number survives, including one quoted back out of the thread', async () => {
    const { followUpDraftSchema } = await import('../src/modules/crm/schema.ts');
    // The reason the prompt has to say so: with the transcript in front of it,
    // a model will happily quote the client's own figure back — and the column
    // refuses a digit, so the message would simply never send.
    assert.match(DRAFT, /none quoted back/);
    assert.equal(followUpDraftSchema.safeParse({ body: 'Kal 50k wali baat pe aapka kya khayal hai?' }).success, false);
    assert.equal(
      followUpDraftSchema.safeParse({ body: 'Kal booking flow pe jo baat hui thi, uspe aapka kya khayal hai?' }).success,
      true,
    );
  });

  test('a nudge stays a nudge — the cap is unchanged', async () => {
    const { followUpDraftSchema } = await import('../src/modules/crm/schema.ts');
    assert.equal(followUpDraftSchema.safeParse({ body: 'a'.repeat(301) }).success, false);
  });
});
