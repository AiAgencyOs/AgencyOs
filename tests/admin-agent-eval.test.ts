import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatCostMinor, whyNotRun, wouldRun } from '../src/lib/admin/agent-eval.ts';

/**
 * "Would run?" is a presentation of gates the database already enforces, never
 * a new gate. The tests pin that reading: an agent runs only when enabled AND a
 * provider is configured AND it has a model — and the reason it would not is
 * the specific missing gate, not a flattened "no".
 */
describe('wouldRun / whyNotRun', () => {
  const runnable = { enabled: true, defaultModel: 'claude-sonnet-5' };

  test('enabled + provider + model would run', () => {
    assert.equal(wouldRun(runnable, true), true);
    assert.equal(whyNotRun(runnable, true), null);
  });

  test('a disabled agent would not run, and says so', () => {
    assert.equal(wouldRun({ ...runnable, enabled: false }, true), false);
    assert.equal(whyNotRun({ ...runnable, enabled: false }, true), 'disabled');
  });

  test('no provider configured blocks even an enabled agent', () => {
    assert.equal(wouldRun(runnable, false), false);
    assert.equal(whyNotRun(runnable, false), 'no AI provider configured');
  });

  test('an enabled agent with no model would not run', () => {
    assert.equal(wouldRun({ enabled: true, defaultModel: null }, true), false);
    assert.equal(whyNotRun({ enabled: true, defaultModel: '  ' }, true), 'no default model set');
  });
});

describe('formatCostMinor', () => {
  test('minor units become a major-unit amount', () => {
    assert.equal(formatCostMinor(100000), '1,000.00');
    assert.equal(formatCostMinor(50), '0.50');
  });
  test('null stays null', () => {
    assert.equal(formatCostMinor(null), null);
  });
});
