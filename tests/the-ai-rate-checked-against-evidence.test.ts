import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { aiSpendSentence, aiSpendLooksLow } from '../src/modules/sales/ai-spend.ts';
import { storedProductionCostFor } from '../src/modules/sales/production-cost.ts';

/**
 * The AI rate, checked against what it actually cost — G-201 (Doc 08, QM-11).
 *
 * ── and the two findings this deliberately does NOT answer ────────────────
 *
 * QM-09 and QM-10 ask for a Claude Code / AI agent **workload analysis**: an
 * estimate of what building a particular client project will cost in agent
 * time. There is nothing in this repository to build that from — no
 * delivery-side agent has ever run — so an "analysis" would be a model
 * guessing token counts for a project nobody has started.
 *
 * That is the fabricated number Doc 05 §35 and ADM-76 both refuse, and it is
 * the refusal migration 156 made about §21's limits. **They are recorded as
 * not built, in the module a reader would open**, rather than filled in.
 *
 * ── what CAN be said ──────────────────────────────────────────────────────
 *
 * The agency sets `pricing_ai_day_rate_rupees`, every cost floor since G-179
 * has used it, and whether it is anywhere near right has never been
 * checkable. Now both halves are rows: what the quotations budgeted, out of
 * each one's own frozen cost block, and what the agents actually cost, out of
 * `ai.cost_ledger`.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = codeOnly(read('src/modules/sales/service.ts'));

describe('A. the sentence says both halves, and its own limitation', () => {
  const base = { budgetedRupees: 20_000, measuredRupees: 8_000, quotations: 4, runs: 250, windowDays: 30 };

  test('both totals, with what each is made of', () => {
    const sentence = aiSpendSentence(base);
    assert.match(sentence!, /budgeted ₹20,000 for AI and tooling across 4 quotations/);
    assert.match(sentence!, /agents actually cost ₹8,000 across 250 runs/);
  });

  test('and the limitation is IN the sentence, never softened', () => {
    // The measured side is the sales agents. A comparison that hid that would
    // be the fabrication wearing a measurement's clothes.
    const sentence = aiSpendSentence(base);
    assert.match(sentence!, /not what building the clients’ software costs, because nothing here builds software yet/);
  });

  test('silent when either half has nothing in it', () => {
    // "0 vs 0" on every settings page is a line nobody reads by the second
    // visit.
    assert.equal(aiSpendSentence({ ...base, quotations: 0 }), null);
    assert.equal(aiSpendSentence({ ...base, runs: 0 }), null);
    assert.equal(aiSpendSentence({ ...base, budgetedRupees: 0, measuredRupees: 0 }), null);
  });

  test('and the singular reads as a person would write it', () => {
    const sentence = aiSpendSentence({ ...base, quotations: 1, runs: 1 });
    assert.match(sentence!, /across 1 quotation,/);
    assert.match(sentence!, /across 1 run\./);
  });
});

describe('B. the flag is advisory and quiet', () => {
  test('silent while the measured cost is anywhere near the budget', () => {
    // Advisory, generous, and never blocking — the posture
    // `productionCostNoteFor` takes about price. A settings page that cried
    // wolf would teach its owner to ignore it.
    assert.equal(aiSpendLooksLow({ budgetedRupees: 20_000, measuredRupees: 20_000, quotations: 3, runs: 90, windowDays: 30 }), false);
    assert.equal(aiSpendLooksLow({ budgetedRupees: 20_000, measuredRupees: 39_999, quotations: 3, runs: 90, windowDays: 30 }), false);
  });

  test('and speaks only at more than double', () => {
    assert.equal(aiSpendLooksLow({ budgetedRupees: 20_000, measuredRupees: 40_001, quotations: 3, runs: 90, windowDays: 30 }), true);
  });

  test('a budget of nothing against a real cost is worth saying', () => {
    assert.equal(aiSpendLooksLow({ budgetedRupees: 0, measuredRupees: 900, quotations: 2, runs: 40, windowDays: 30 }), true);
  });

  test('but nothing on either side is not', () => {
    assert.equal(aiSpendLooksLow({ budgetedRupees: 0, measuredRupees: 0, quotations: 2, runs: 40, windowDays: 30 }), false);
    assert.equal(aiSpendLooksLow({ budgetedRupees: 20_000, measuredRupees: 90_000, quotations: 0, runs: 40, windowDays: 30 }), false);
  });
});

describe('C. both halves are rows — neither is estimated', () => {
  test('the rates are FROZEN onto the quotation that used them', () => {
    // The basis lines have always said them in prose. Storing them as numbers
    // adds no new claim and makes the block answerable.
    const stored = storedProductionCostFor(
      { items: [{ description: 'Customer app', effortDays: 10 }] },
      { dayRateRupees: 4_000, aiDayRateRupees: 600, multiplierMin: 2, multiplierTarget: 2.5, multiplierMax: 3 },
    );
    assert.equal(stored?.dayRateRupees, 4_000);
    assert.equal(stored?.aiDayRateRupees, 600);
    assert.equal(stored?.days, 10);
  });

  test('the budgeted half is read from that block, never re-derived', () => {
    // Re-deriving with today's settings would answer the question with the
    // number under test.
    assert.match(SERVICE, /budgetedRupees \+= days \* rate;/);
    // The reason lives in a comment, which `codeOnly` strips — so it is
    // asserted against the file a reader would actually open.
    assert.match(read('src/modules/sales/service.ts'), /answering the question with the number under test/);
  });

  test('a quotation frozen before the rates existed is SKIPPED, not guessed at', () => {
    assert.match(SERVICE, /if \(days === null \|\| rate === null\) continue;/);
  });

  test('and the measured half is the ledger, refused rather than zeroed on a failed read', () => {
    // A settings page telling an owner their agents cost nothing, because the
    // ledger could not be read, is worse than one that says it could not check.
    assert.match(SERVICE, /unreadable\('readAiSpendComparison\.ledger', ledgerError\)/);
    assert.match(SERVICE, /unreadable\('readAiSpendComparison\.quotations', quotationsError\)/);
  });
});

describe('D. what was deliberately not built, and where a reader will find out', () => {
  test('QM-09 and QM-10 are named in the module, with the reason', () => {
    const prose = read('src/modules/sales/ai-spend.ts');
    assert.match(prose, /QM-09 and QM-10 ask for a \*\*Claude Code \/ AI agent workload analysis\*\*/);
    assert.match(prose, /nothing in this repository to build that from/);
    assert.match(prose, /QM-09 and QM-10 are not built/);
  });

  test('and nothing anywhere estimates agent time for an unbuilt project', () => {
    const spend = codeOnly(read('src/modules/sales/ai-spend.ts'));
    for (const invented of ['tokensEstimated', 'estimatedTokens', 'predictedRuns', 'forecast']) {
      assert.ok(!spend.includes(invented), `${invented} would be a guess wearing a measurement's clothes`);
    }
  });
});
