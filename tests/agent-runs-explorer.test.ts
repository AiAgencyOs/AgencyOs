import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  distinctValues,
  formatDurationMs,
  runDurationMs,
  stepToolName,
  summariseRuns,
} from '../src/lib/admin/agent-runs-eval.ts';

/**
 * The runs explorer's KPI row and step trace are arithmetic over recorded
 * rows. The promises: an empty ledger reports no average rather than zero,
 * only `failed` counts as a failure, cost is summed in minor units as stored,
 * and a duration is shown only when both ends were written down.
 */
describe('summariseRuns', () => {
  it('reports no average, not zero, when nothing has run', () => {
    assert.deepEqual(summariseRuns([]), { runs: 0, failed: 0, avgSteps: null, totalCostMinor: 0 });
  });

  it('counts only failed runs as failures', () => {
    const s = summariseRuns([
      { status: 'failed', stepCount: 2, costMinor: 10 },
      { status: 'succeeded', stepCount: 4, costMinor: 20 },
      { status: 'cancelled', stepCount: 1, costMinor: 0 },
      { status: 'running', stepCount: 0, costMinor: 0 },
    ]);
    assert.equal(s.runs, 4);
    assert.equal(s.failed, 1);
  });

  it('averages steps to one decimal and sums cost in minor units', () => {
    const s = summariseRuns([
      { status: 'succeeded', stepCount: 3, costMinor: 150 },
      { status: 'succeeded', stepCount: 4, costMinor: 275 },
      { status: 'failed', stepCount: 1, costMinor: 5 },
    ]);
    assert.equal(s.avgSteps, 2.7);
    assert.equal(s.totalCostMinor, 430);
  });
});

describe('runDurationMs', () => {
  it('is null unless both ends are recorded', () => {
    assert.equal(runDurationMs(null, '2026-09-29T10:00:05Z'), null);
    assert.equal(runDurationMs('2026-09-29T10:00:00Z', null), null);
  });

  it('is the wall-clock gap when both are', () => {
    assert.equal(runDurationMs('2026-09-29T10:00:00Z', '2026-09-29T10:00:05.500Z'), 5500);
  });

  it('refuses a finish before its start', () => {
    assert.equal(runDurationMs('2026-09-29T10:00:05Z', '2026-09-29T10:00:00Z'), null);
  });
});

describe('formatDurationMs', () => {
  it('picks the unit by magnitude', () => {
    assert.equal(formatDurationMs(840), '840ms');
    assert.equal(formatDurationMs(1234), '1.2s');
    assert.equal(formatDurationMs(125_000), '2m 05s');
  });

  it('has nothing to say about a missing or negative value', () => {
    assert.equal(formatDurationMs(null), null);
    assert.equal(formatDurationMs(-1), null);
  });
});

describe('stepToolName', () => {
  it('reads a tool name from a recorded tool-call request', () => {
    assert.equal(stepToolName({ tool: 'send_message', input: {} }), 'send_message');
    assert.equal(stepToolName({ name: 'lookup_lead' }), 'lookup_lead');
  });

  it('does not guess from anything else', () => {
    assert.equal(stepToolName(null), null);
    assert.equal(stepToolName('send_message'), null);
    assert.equal(stepToolName(['send_message']), null);
    assert.equal(stepToolName({ tool: '   ' }), null);
    assert.equal(stepToolName({ messages: [] }), null);
  });
});

describe('distinctValues', () => {
  it('keeps first-seen order and drops blanks', () => {
    const rows = [{ m: 'b' }, { m: null }, { m: 'a' }, { m: 'b' }, { m: '' }];
    assert.deepEqual(distinctValues(rows, (r) => r.m), ['b', 'a']);
  });
});
