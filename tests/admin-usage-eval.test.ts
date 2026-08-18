import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { aggregateUsage } from '../src/lib/admin/usage-eval.ts';

describe('aggregateUsage — sums only what was recorded, invents nothing', () => {
  test('no runs and no steps yields empty usage and zero totals', () => {
    const { perAgent, totals } = aggregateUsage([], []);
    assert.deepEqual(perAgent, []);
    assert.deepEqual(totals, { runs: 0, inputTokens: 0, outputTokens: 0, costMinor: 0 });
  });

  test('runs sum tokens per agent; steps attribute cost to the run’s agent', () => {
    const { perAgent, totals } = aggregateUsage(
      [
        { agent_key: 'lead_qualifier', input_tokens: 100, output_tokens: 40 },
        { agent_key: 'lead_qualifier', input_tokens: 60, output_tokens: 20 },
        { agent_key: 'proposal_drafter', input_tokens: 200, output_tokens: 90 },
      ],
      [
        { cost_minor: 150, agent_key: 'lead_qualifier' },
        { cost_minor: 50, agent_key: 'lead_qualifier' },
        { cost_minor: 300, agent_key: 'proposal_drafter' },
      ],
    );
    const lq = perAgent.find((a) => a.agentKey === 'lead_qualifier')!;
    assert.equal(lq.runs, 2);
    assert.equal(lq.inputTokens, 160);
    assert.equal(lq.outputTokens, 60);
    assert.equal(lq.costMinor, 200);
    assert.equal(totals.runs, 3);
    assert.equal(totals.costMinor, 500);
    // Sorted by cost desc: proposal_drafter (300) before lead_qualifier (200).
    assert.equal(perAgent[0]!.agentKey, 'proposal_drafter');
  });

  test('a step whose agent could not be resolved is in totals but misattributed to no agent', () => {
    const { perAgent, totals } = aggregateUsage(
      [{ agent_key: 'lead_qualifier', input_tokens: 10, output_tokens: 5 }],
      [
        { cost_minor: 100, agent_key: 'lead_qualifier' },
        { cost_minor: 77, agent_key: null }, // orphan cost
      ],
    );
    assert.equal(perAgent.find((a) => a.agentKey === 'lead_qualifier')!.costMinor, 100);
    assert.equal(totals.costMinor, 177); // orphan counted in totals, not on any agent
    assert.equal(perAgent.reduce((n, a) => n + a.costMinor, 0), 100); // never misattributed
  });
});
