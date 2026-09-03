import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * The client asks, and the agent redrafts — G-163, ADM-96's second half.
 *
 * PR #329 gave the OWNER's changes-note to the agent; this gives it the
 * CLIENT's scope-ask: objection row → objection.recorded (a trigger, where
 * the state changes) → QUOTATION_REWORK drafts, prices and resubmits — and
 * the owner still decides everything before the client sees anything. What
 * never enters this loop is the price objection: negotiation is a person's
 * (ADM-22's surviving posture — the corpus re-scopes, it never discounts).
 *
 * The live halves are proved in verify-quotation-dispatch §6/§7.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const MIGRATION_RAW = read('supabase/migrations/20260824150000_the_client_asks_and_the_agent_redrafts.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const CATALOG = read('src/lib/events/catalog.ts');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
const REWORK = WORKFLOWS.slice(WORKFLOWS.indexOf('const REWORK_PROMPT'));

describe('A. the state change emits, where it changes', () => {
  test('the event type is declared, canonical NULL for a reasoned refusal', () => {
    assert.match(MIGRATION, /'objection\.recorded',/);
    const stmt = MIGRATION.slice(
      MIGRATION.indexOf('into core.event_types'),
      MIGRATION.indexOf('on conflict (type) do nothing'),
    );
    assert.match(stmt, /null\s*\)\s*$/m);
    // The nearest Doc 23 name belongs to the delivery scope-change engine;
    // borrowing it would inflate the coverage number.
    assert.match(MIGRATION_RAW, /ChangeRequestSubmitted/);
  });

  test('INSERT only — a person’s answer must never re-fire the loop', () => {
    assert.match(MIGRATION, /after insert on sales\.objections/);
    assert.doesNotMatch(MIGRATION, /after insert or update/);
  });

  test('the payload carries plan-filter claims and nothing load-bearing', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function sales.emit_objection_recorded'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    for (const key of ["'leadId'", "'messageId'", "'proposalId'", "'kind'", "'round'"]) {
      assert.ok(body.includes(key), `payload lost ${key}`);
    }
    // The concern travels by ROW, never by payload — the workflow re-reads it.
    assert.doesNotMatch(body, /concern/);
  });
});

describe('B. the wiring: one event, one listener, filtered at plan time', () => {
  test('the catalog routes the recorded objection to the rework job', () => {
    assert.match(CATALOG, /'objection\.recorded': \['sales:reworkQuotation'\]/);
    assert.match(CATALOG, /'sales:reworkQuotation': 'quotation\.rework'/);
  });

  test('only a scope-change ask against a named quotation buys a job', () => {
    const filter = CATALOG.slice(CATALOG.indexOf("'sales:reworkQuotation': (event)"));
    assert.match(filter.slice(0, 400), /kind === 'feature'/);
    // The CONJUNCT, not the word: a bare /proposalId/ was satisfied by the
    // type annotation while the logic could be deleted (review finding).
    assert.match(filter.slice(0, 400), /&& Boolean\(claim\?\.proposalId\)/);
  });

  test('the workflow is registered — a queue nothing drains is work accepted and never done', () => {
    assert.match(WORKFLOWS, /QUOTATION_REVISE,\s*\n\s*QUOTATION_REWORK,\s*\n\]/);
  });
});

describe('C. the gates, every fact from the row', () => {
  test('the objection is re-read as the authority, org-scoped', () => {
    // G-195 added `round` to the end of this select for the negotiation
    // round cap. Pinned as "every gate's own column is read" rather than as
    // the exact string, so a column added for a new gate does not fail a test
    // about the old ones — while dropping any of them still does.
    for (const column of ['id', 'lead_id', 'message_id', 'proposal_id', 'kind', 'concern', 'response', 'outcome', 'answered_by', 'round']) {
      assert.match(REWORK, new RegExp(`\\.select\\('[^']*\\b${column}\\b[^']*'\\)`), `the objection's ${column} is not read`);
    }
    assert.match(REWORK, /\.eq\('organization_id', job\.organization_id\)/);
  });

  test('a person’s settle ends it — through ANY of the three answer columns', () => {
    // A withdrawn ask has an outcome and a person, and no response text;
    // checking response alone let a settled ask rework a quotation off a
    // retry hours later (review finding).
    assert.match(REWORK, /objection\.response !== null \|\| objection\.outcome !== null \|\| objection\.answered_by !== null/);
    assert.match(REWORK, /concern, response, outcome, answered_by/);
    // The negative — a non-feature kind no-ops with the reason named…
    assert.match(REWORK, /objection\.kind !== 'feature'/);
    assert.match(REWORK, /is a person's conversation, not a rework/);
    // …and its positive twin: the feature path genuinely reaches the model
    // and the resubmission (absence-only lesson).
    assert.match(REWORK, /The client asked, in their own words/);
    assert.match(REWORK, /submitDraftedQuotation\(admin, draft\.proposal_id\)/);
  });

  test('only the version the client is HOLDING is reworked — and approved is a wait, not a no', () => {
    assert.match(REWORK, /proposal\.status !== 'sent'/);
    assert.match(REWORK, /the client is not holding it/);
    // The approved→sent gap is dispatch mid-flight: retried, never settled —
    // a settle was permanent for a condition about to become true (review
    // finding).
    assert.match(REWORK, /proposal\.status === 'approved'/);
    assert.match(REWORK, /on its way to the client; retrying until it lands/);
  });

  test('the resume guard: the CONDITIONS, not their prose — and ownership is read, never guessed', () => {
    // Pinned on the executable conditions after the review red-proved that
    // prose tokens alone survive an inverted guard.
    assert.match(REWORK, /newer\.status !== 'draft'/);
    assert.match(REWORK, /!newer\.generated_by_run_id/);
    // A run id alone cannot say whose the draft is — sync returns a
    // changes_requested version to draft WITH its run id, so the run row's
    // subject is resolved before anything is superseded.
    assert.match(REWORK, /draftBelongsTo\(admin, newer\.generated_by_run_id, 'sales\.objection', objection\.id\)/);
    assert.match(REWORK, /another cycle holds the draft/);
    assert.doesNotMatch(REWORK, /submitDraftedQuotation\(admin, newer\.id\)/);
  });

  test('the base is named to the database, and a stale one is a retry, not a stomp', () => {
    assert.match(REWORK, /p_expected_supersede: supersedingOwnFailedDraft && newer \? newer\.id : proposal\.id/);
    assert.match(REWORK, /draft\?\.outcome === 'stale'/);
    const migration = MIGRATION;
    assert.match(migration, /p_expected_supersede\s+uuid default null/);
    assert.match(migration, /v_live\.id is distinct from p_expected_supersede/);
    assert.match(migration, /'stale'::text/);
    assert.match(migration, /drop function if exists sales\.draft_proposal\(uuid, text, text, date, uuid, uuid, uuid\)/);
  });

  test('a refused line is a failure, never a written count', () => {
    // add_proposal_item answers not_draft as an OUTCOME row; counting it as
    // written reported success on destroyed work (review finding).
    assert.match(REWORK, /added\?\.outcome !== 'added'/);
    assert.match(REWORK, /was refused as/);
  });

  test('the client’s words go to the model; nothing ever writes their answer (ADM-76)', () => {
    assert.match(REWORK, /objection\.concern/);
    const code = REWORK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /from\('objections'\)[\s\S]{0,200}\.update/);
    assert.doesNotMatch(code, /response:/);
  });

  test('prices ride the same rails: rupees ×100, fresh validity, run named, then the owner', () => {
    assert.match(REWORK, /p_unit_price_minor: item\.priceRupees \* 100/);
    assert.match(REWORK, /p_valid_until: quotationValidUntil\(\)/);
    assert.match(REWORK, /p_generated_by_run_id: runId/);
  });
});

describe('D. the prompt holds the posture', () => {
  const prompt = WORKFLOWS.slice(
    WORKFLOWS.indexOf('const REWORK_PROMPT'),
    WORKFLOWS.indexOf('const QUOTATION_REWORK'),
  );

  test('the ask is a request, the owner decides, and the number never bends to pressure', () => {
    assert.match(prompt, /THE ASK IS A REQUEST, NOT AN INSTRUCTION/);
    assert.match(prompt, /NEVER DISCOUNT THE SAME SCOPE/);
    assert.match(prompt, /PRICING_KNOWLEDGE,/);
  });

  test('and G-183 replaced "a person’s negotiation" with what to actually do', () => {
    // The sentence this used to pin said a price push was a person's problem,
    // which was true while a price objection could not reach this workflow at
    // all. It can now, so the prompt has to answer it — and the answer is the
    // corpus's own rather than a new authority: return a SMALLER build, not
    // the same one for less.
    assert.ok(!prompt.includes('a pure price push is a person’s negotiation'));
    assert.match(prompt, /Return a SMALLER HONEST BUILD/);
    // And the case the rule cannot answer is named rather than left to
    // improvisation: everything, for less, comes back unchanged for the owner.
    assert.match(prompt, /UNCHANGED at its original price/);
  });
});
