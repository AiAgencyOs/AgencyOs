import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { planJobsForEvent } from '../src/lib/events/catalog.ts';

/**
 * A price objection turns the loop — G-183.
 *
 * A zero-trust audit traced the flow's NEGOTIATION step and found that three
 * of the four objection kinds ended in a person's queue. Only a scope-change
 * objection redrafted anything; a client saying *"₹87,000 is too much for us"*
 * produced a row, a rank and nothing else.
 *
 * The reason given was ADM-22's posture — *the agent may not move a number
 * under client pressure* — and it conflated two different things.
 *
 * ── what ADM-22 actually forbids ──────────────────────────────────────────
 *
 * A number reaching a CLIENT without a person deciding it. **A rework decides
 * nothing.** It drafts a version and submits it for approval, exactly as the
 * scope-change loop has since G-163, and the owner sees it before anybody
 * else. Refusing to draft did not protect the price — it left the entire
 * response to a person while the ask sat in a queue.
 *
 * So the gate widened and the authority did not. The owner's decision, taken
 * on this audit, was explicit that the redraft loop should answer a price
 * push.
 *
 * ── and the corpus's discipline moved rather than went ────────────────────
 *
 * *Protect the number by cutting scope, never by discounting* now lives in the
 * prompt, where it is an instruction about what to draft, instead of in the
 * wiring, where it was an instruction not to draft at all. The agent returns a
 * SMALLER honest build — and when the ask cannot be answered that way, it
 * returns the scope unchanged at its original price and lets the owner decide
 * whether to make an exception.
 *
 * `trust` and `timeline` still never enter it. Neither is a scope, and a
 * client who does not trust you is not asking for a different quotation.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
/**
 * Two readings of each file, and the distinction is load-bearing.
 *
 * `codeOnly` for claims about CODE — a comment mentioning a construct must not
 * satisfy an assertion that the construct exists. The raw text for claims about
 * PROSE, because the reasoning a change rests on is worth pinning too, and it
 * lives in comments by definition.
 */
const CATALOG = codeOnly(read('src/lib/events/catalog.ts'));
const CATALOG_RAW = read('src/lib/events/catalog.ts');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const WORKFLOWS_RAW = read('app/api/jobs/run/workflows.ts');

const event = (kind: string, proposalId: string | null) => ({
  id: 1,
  organization_id: 'org-1',
  type: 'objection.recorded',
  subject_type: 'objection',
  subject_id: 'obj-1',
  payload: { kind, proposalId },
});

const reworks = (kind: string, proposalId: string | null = 'prop-1') =>
  planJobsForEvent(event(kind, proposalId)).some((j) => j.kind === 'quotation.rework');

describe('A. which objections buy a redraft', () => {
  test('a price objection now does', () => {
    assert.equal(reworks('price'), true);
  });

  test('and a scope-change objection still does', () => {
    assert.equal(reworks('feature'), true);
  });

  test('trust does not — a client who does not trust you wants a conversation', () => {
    assert.equal(reworks('trust'), false);
  });

  test('and neither does timeline', () => {
    // Not a scope. Since G-177 the timeline IS a field the owner can revise,
    // but a client objecting to it is asking a person a question, and a
    // redraft would answer one nobody asked.
    assert.equal(reworks('timeline'), false);
  });

  test('none of them does without a quotation to rework', () => {
    // The filter only decides whether to spend a job; a rework with nothing
    // named would claim one to say "nothing to do".
    assert.equal(reworks('price', null), false);
    assert.equal(reworks('feature', null), false);
  });
});

describe('B. the ROW is still the authority, and it agrees', () => {
  test('the workflow admits exactly the two kinds the filter plans', () => {
    // The plan filter reads the payload, which is a claim. A forged one buys a
    // job that reads the row and answers "not a rework" — so the two lists
    // must agree, or a real objection is dropped by one of them.
    assert.match(WORKFLOWS, /objection\.kind !== 'feature' && objection\.kind !== 'price'/);
    assert.match(CATALOG, /claim\?\.kind === 'feature' \|\| claim\?\.kind === 'price'/);
  });

  test('and still refuses an objection that names no quotation', () => {
    assert.match(WORKFLOWS, /the ask names no quotation to rework/);
  });
});

describe('C. the discipline moved into the prompt, and got sharper', () => {
  test('the rule is stated as what to DO, not as a refusal', () => {
    assert.match(WORKFLOWS, /NEVER DISCOUNT THE SAME SCOPE/);
    assert.match(WORKFLOWS, /Return a SMALLER HONEST BUILD/);
    // And what "smaller" means concretely, so it is followable: drop what
    // costs most and matters least, and say so in the exclusions.
    assert.match(WORKFLOWS, /drop or defer the lines that cost the most/);
    assert.match(WORKFLOWS, /say plainly in the exclusions what is no longer/);
  });

  test('the case the rule cannot answer is named rather than improvised', () => {
    // They want everything, for less. A draft that quietly shaved the number
    // would have made the owner's decision for them.
    assert.match(WORKFLOWS, /UNCHANGED at its original price/);
    assert.match(WORKFLOWS, /would have made that decision for them/);
  });

  test('and the sentence that said a price push was not the agent’s business is gone', () => {
    // It was true while a price objection could not reach the workflow. It is
    // now the opposite of the behaviour, and a prompt that contradicts the
    // wiring is worse than one that says nothing.
    assert.ok(!WORKFLOWS.includes('a pure price push is a person’s negotiation'));
  });

  test('the reworked version still goes to the owner, never to the client', () => {
    // The whole reason widening the gate did not widen the authority.
    // Both of these are prose — the instruction the model is given, and the
    // reasoning the widened gate rests on — so they are read unstripped.
    assert.match(WORKFLOWS_RAW, /the owner decides the result before the client sees anything \(ADM-07\)/);
    assert.match(CATALOG_RAW, /A rework decides nothing/);
  });
});
