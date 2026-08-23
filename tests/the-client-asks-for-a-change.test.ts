import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * The client asks for a change — brief §23/§24, gap G-157.
 *
 * Nearly all of the revision loop already existed: the structured change
 * request is a `sales.objections` row (§19/§20), the revised version is
 * `draft_proposal`'s supersede, the owner's review is the approval engine,
 * v2 to the client is `send_proposal` — and §26's own instruction was "do
 * not create a duplicate state machine if one already exists". What was
 * missing is four small connections, and these tests hold them:
 *
 *   the ask becomes a row     emit_objection_raised fires on change_request
 *   the queue tells the truth lead_attention's revision_asked tier
 *   the person can see it     the lead page lists open objections
 *   the agent keeps §23       acknowledge, confirm internally, promise nothing
 *
 * The database halves are proved live in verify-quotations §15; what is
 * here is the wording, the wiring, and the D16 carry-forward fidelity.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const migration = read(
  '../supabase/migrations/20260823220000_the_client_asks_for_a_change.sql',
);
const workflows = read('../app/api/jobs/run/workflows.ts');

describe('A. the ask becomes a row', () => {
  test('the objection gate now includes change_request — and keeps its original three', () => {
    assert.match(
      migration,
      /intent in \('price_inquiry', 'negotiation', 'trust_concern', 'change_request'\)/,
    );
    // Still only on the FIRST labelling: re-labelling must not re-raise.
    assert.match(migration, /and old\.intent is null/);
  });

  test('the intent read is told where change_request applies, in terms it can actually observe', () => {
    const prompt = workflows.slice(
      workflows.indexOf('const INTENT_PROMPT'),
      workflows.indexOf('const MESSAGE_INTENT'),
    );
    assert.match(prompt, /asking to change, add to, remove from, or re-price a quotation/);
    // The classifier reads ONE message — it cannot see whether a quotation
    // was sent, so the rule must key on the client's own words naming one.
    assert.match(prompt, /their words will name one, you cannot see it/);
    assert.match(prompt, /on a lead',\s*\n\s*'as much as on a project/);
  });

  test('the objection read’s feature kind covers a scope ask', () => {
    assert.match(workflows, /asking to add',\s*\n\s*'or remove something from the scope/);
  });
});

describe('B. the queue tells the truth', () => {
  test('revision_asked sits between "they wrote last" and "quote out, no answer"', () => {
    const order = migration.slice(migration.indexOf('order by'), migration.indexOf('limit greatest'));
    const ranks = [
      ['agent_paused_at is not null then 1', 'handed_over'],
      ["author_type = 'client'      then 2", 'waiting_on_us'],
      ['rv.at is not null             then 3', 'revision_asked'],
      ['q.sent_at is not null         then 4', 'quoted_no_answer'],
    ] as const;
    for (const [clause, tier] of ranks) {
      assert.ok(order.includes(clause), `${tier} moved`);
    }
  });

  test('the tier matches an OPEN objection against the version that is OUT — every half load-bearing', () => {
    // Anchored inside the revising CTE itself: the carried-forward
    // `unanswered` and `quoted` CTEs also contain these strings, and a
    // whole-file match would stay green with the new CTE gutted.
    const revising = migration.slice(
      migration.indexOf('revising as ('),
      migration.indexOf('unanswered as ('),
    );
    assert.ok(revising.length > 100, 'the revising CTE is gone entirely');
    assert.match(revising, /ob\.response is null/);
    assert.match(revising, /p\.status = 'sent'/);
    assert.match(revising, /p\.sent_at is not null/);
    // And the version must belong to the objection's own lead — an
    // objection citing another lead's proposal must rank nobody.
    assert.match(revising, /po\.lead_id = ob\.lead_id/);
  });

  test('it clears itself by superseding, never by fabricating a response (ADM-76)', () => {
    const sql = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    assert.ok(
      !/update sales\.objections/i.test(sql) && !/set response/i.test(sql),
      'something in this migration writes into an objection — the response is what a PERSON said',
    );
  });

  test('the carry-forwards kept what they carried (D16)', () => {
    for (const kept of [
      // lead_attention: the tiers that were already there
      "'handed_over'",
      "'waiting_on_us'",
      "'quoted_no_answer'",
      "'ready_to_quote'",
      "'open_objection'",
      "'never_answered'",
      'asc nulls last',
      'limit greatest(p_limit, 0)',
      // the emit trigger: statement shape unchanged
      'after update of intent on crm.conversation_messages',
    ]) {
      assert.ok(migration.includes(kept), `the carry-forward lost: ${kept}`);
    }
  });

  test('the leads screen names the tier as an action', () => {
    const page = read('../app/(internal)/leads/page.tsx');
    assert.match(page, /revision_asked/);
    assert.match(page, /Asked to change the quote/);
  });
});

describe('C. the person can see the ask', () => {
  const leadPage = read('../app/(internal)/leads/[leadId]/page.tsx');

  test('the lead page loads and renders open objections — the rows no UI read before', () => {
    assert.match(leadPage, /listOpenObjectionsForLead\(leadId\)/);
    assert.match(leadPage, /They asked — nobody has answered/);
    assert.match(leadPage, /\{o\.concern\}/);
  });

  test('and points at the next step of the loop: draft the next version', () => {
    assert.match(leadPage, /Drafting the next version below is what answers a/);
    // Outside the Quotations card: an objection needs only a lead, and a
    // concern raised before any deal exists is still work.
    const box = leadPage.indexOf('They asked — nobody has answered');
    const card = leadPage.indexOf('── Quotations (G-011, ADM-07)');
    assert.ok(box !== -1 && card !== -1 && box < card, 'the box moved back inside the opportunity conditional');
  });

  test('the query refuses to render silence as “no concerns” (G-054)', () => {
    const queries = read('../src/modules/sales/queries.ts');
    const fn = queries.slice(queries.indexOf('listOpenObjectionsForLead'));
    assert.match(fn, /unreadable\('listOpenObjectionsForLead', error\)/);
    assert.match(fn, /\.is\('response', null\)/);
  });
});

describe('D. the agent keeps §23’s script', () => {
  test('the composer’s standing rule: acknowledge, confirm internally, promise nothing', () => {
    const prompt = workflows.slice(
      workflows.indexOf('const REPLY_PROMPT'),
      workflows.indexOf('function salesFileFor'),
    );
    assert.match(prompt, /are not yours to grant or refuse/);
    assert.match(prompt, /confirm an updated quotation internally/);
    assert.match(prompt, /This is not a hand-over; keep the conversation/);
  });

  test('the sales file says it again once the objection row exists — both sides of the same-tick race', () => {
    assert.match(workflows, /They have asked for the quotation to change/);
    assert.match(workflows, /the revision is not yours to shape/);
    // Gated on an OPEN objection against THE SENT VERSION — the same
    // condition as the revision_asked tier, so the queue and the agent's
    // file never tell two different stories about one lead.
    const at = workflows.indexOf('They have asked for the quotation to change');
    const before = workflows.slice(at - 900, at);
    assert.match(before, /o\.response === null && o\.proposal_id === sent\.id/);
  });

  test('mid-loop, the file names the version the client is actually holding', () => {
    assert.match(workflows, /They are holding an older quotation \(v\$\{held\.version\}\)/);
    // The newest SENT version, not the first superseded row in the array.
    const at = workflows.indexOf('const held = file.proposals');
    const block = workflows.slice(at, at + 300);
    assert.match(block, /filter\(\(p\) => p\.sent_at !== null\)/);
    assert.match(block, /sort\(\(a, b\) => b\.version - a\.version\)/);
  });

  test('what it never says: a promise, a price, a date', () => {
    const at = workflows.indexOf('They have asked for the quotation to change');
    const line = workflows.slice(at, at + 400);
    assert.match(line, /Do NOT promise any change, any price, or any date/);
  });
});
