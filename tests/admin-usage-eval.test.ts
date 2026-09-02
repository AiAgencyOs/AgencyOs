import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { aggregateLedger } from '../src/lib/admin/usage-eval.ts';

/**
 * Usage & cost aggregation — G-186 replaced what this file used to test.
 *
 * It tested `aggregateUsage`, which added up run rows for tokens and step rows
 * for cost in the application, from every row ever recorded, under a
 * 10,000-row cap. Past that cap the page reported **a partial total as if it
 * were the total** — a spend figure that silently under-reports, which is
 * worse than no spend figure at all.
 *
 * `ai.cost_ledger` answers the same question already summed, one row per day
 * per agent per model. The old aggregator is gone rather than left beside this
 * one: two ways to compute one money figure is two figures that can disagree,
 * and the one nobody reads is the one that drifts.
 *
 * The orphan-cost case the old suite covered went with it, and deliberately —
 * a step whose run could not be resolved was possible because cost was joined
 * to its agent in the application. A ledger row carries `agent_key` as a NOT
 * NULL column with a foreign key, so there is no orphan to attribute.
 */

describe('aggregateLedger — sums only what was recorded, invents nothing', () => {
  test('no rows yields empty usage and zero totals', () => {
    const { perAgent, totals } = aggregateLedger([]);
    assert.deepEqual(perAgent, []);
    assert.deepEqual(totals, { runs: 0, inputTokens: 0, outputTokens: 0, costMinor: 0 });
  });

  test('days are summed per agent, and the totals are the sum of those', () => {
    const { perAgent, totals } = aggregateLedger([
      { agent_key: 'lead_qualifier', runs: 1, input_tokens: 100, output_tokens: 40, cost_minor: 150 },
      { agent_key: 'lead_qualifier', runs: 1, input_tokens: 60, output_tokens: 20, cost_minor: 50 },
      { agent_key: 'proposal_drafter', runs: 1, input_tokens: 200, output_tokens: 90, cost_minor: 300 },
    ]);
    const lq = perAgent.find((a) => a.agentKey === 'lead_qualifier')!;
    assert.equal(lq.runs, 2);
    assert.equal(lq.inputTokens, 160);
    assert.equal(lq.outputTokens, 60);
    assert.equal(lq.costMinor, 200);
    assert.equal(totals.runs, 3);
    assert.equal(totals.costMinor, 500);
  });

  test('one agent’s two models are one line on the page', () => {
    // The ledger splits by model as well as by day, because a retargeted agent
    // costs a different amount and an owner comparing months needs to see
    // which. The page asks a different question, so it adds them.
    const { perAgent } = aggregateLedger([
      { agent_key: 'sales', runs: 3, input_tokens: 30, output_tokens: 10, cost_minor: 90 },
      { agent_key: 'sales', runs: 2, input_tokens: 20, output_tokens: 5, cost_minor: 40 },
    ]);
    assert.equal(perAgent.length, 1);
    assert.equal(perAgent[0]!.runs, 5);
    assert.equal(perAgent[0]!.costMinor, 130);
  });

  test('the costliest agent is first — the page is read top-down', () => {
    const { perAgent } = aggregateLedger([
      { agent_key: 'lead_qualifier', runs: 2, input_tokens: 160, output_tokens: 60, cost_minor: 200 },
      { agent_key: 'proposal_drafter', runs: 1, input_tokens: 200, output_tokens: 90, cost_minor: 300 },
    ]);
    assert.equal(perAgent[0]!.agentKey, 'proposal_drafter');
  });

  test('an agent that ran and cost nothing is still shown', () => {
    // A run that failed before its first call spent nothing and still
    // happened. Dropping it would make a broken agent invisible on the one
    // page that would show it.
    const { perAgent, totals } = aggregateLedger([
      { agent_key: 'quality_assurance', runs: 4, input_tokens: 0, output_tokens: 0, cost_minor: 0 },
    ]);
    assert.equal(perAgent.length, 1);
    assert.equal(perAgent[0]!.runs, 4);
    assert.equal(totals.costMinor, 0);
  });
});
