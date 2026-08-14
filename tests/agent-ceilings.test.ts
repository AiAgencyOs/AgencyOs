import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  MAX_HANDOFF_DEPTH,
  mayContinue,
  mayHandOffAtDepth,
} from '../src/modules/agents/ceilings.ts';

/**
 * The ceilings that stop an agent running away — gaps G-133 and G-134.
 *
 * Both controls existed as schema and neither was connected to anything:
 * `max_steps` and `max_cost_minor` had no consumer, and `handoffs.depth` had
 * no producer. `ai.agent_runs.budget_exceeded` — a terminal status named for
 * exactly this — had never been set by any code.
 *
 * These tests are written as attempts to get past the limits, because that is
 * what the limits are for.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120006_the_ceilings_start_holding.sql');

const CEILINGS = { maxSteps: 20, maxCostMinor: 2000 };

describe('A. the step ceiling', () => {
  test('below it, work continues', () => {
    assert.equal(mayContinue({ steps: 19, costMinor: 0 }, CEILINGS).ok, true);
  });

  test('at it, the run stops', () => {
    // Asked *before* the next step, so reaching the ceiling means the next one
    // may not be taken. `>=` rather than `>` is the whole distinction between
    // a limit and a report of having passed one.
    const r = mayContinue({ steps: 20, costMinor: 0 }, CEILINGS);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error.message, /step ceiling reached: 20 of 20/);
  });

  test('and past it too', () => {
    assert.equal(mayContinue({ steps: 999, costMinor: 0 }, CEILINGS).ok, false);
  });
});

describe('B. the cost ceiling', () => {
  test('below it, work continues', () => {
    assert.equal(mayContinue({ steps: 0, costMinor: 1999 }, CEILINGS).ok, true);
  });

  test('at it, the run stops', () => {
    const r = mayContinue({ steps: 0, costMinor: 2000 }, CEILINGS);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error.message, /cost ceiling reached: 2000 of 2000/);
  });

  test('a zero ceiling permits nothing, rather than everything', () => {
    // The failure mode worth checking: a falsy limit read as "no limit" is how
    // a ceiling silently becomes decorative, which is the defect this closes.
    assert.equal(mayContinue({ steps: 0, costMinor: 0 }, { maxSteps: 0, maxCostMinor: 0 }).ok, false);
  });

  test('and either ceiling alone is enough to stop it', () => {
    assert.equal(mayContinue({ steps: 20, costMinor: 0 }, CEILINGS).ok, false);
    assert.equal(mayContinue({ steps: 0, costMinor: 2000 }, CEILINGS).ok, false);
  });
});

describe('C. the handoff depth bound', () => {
  test('the bound is 8, matching the column and the trigger', () => {
    assert.equal(MAX_HANDOFF_DEPTH, 8);
    assert.match(migration, /if v_depth > 8 then/);
  });

  test('below it a handoff is allowed', () => {
    assert.equal(mayHandOffAtDepth(7).ok, true);
  });

  test('at it the chain stops', () => {
    const r = mayHandOffAtDepth(8);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error.message, /A chain this long is a loop, not progress/);
  });
});

describe('D. the database derives depth rather than trusting it', () => {
  test('the trigger ignores what the caller passed', () => {
    // The defect: `depth` defaulted to 0 and nothing computed it, so
    // `check (depth <= 8)` bounded a number the caller chose. A caller that
    // always passes 0 — or simply omits it — was never bounded at all.
    assert.match(migration, /Ignores new\.depth entirely/);
    assert.match(migration, /select coalesce\(max\(h\.depth\), -1\) \+ 1/);
    assert.match(migration, /new\.depth := v_depth;/);
  });

  test('and it derives from the correlation chain, not a parent column', () => {
    // Matches what 20260814120003 already recorded as the unit of tracing, and
    // needs no new column, so nothing has to be backfilled.
    assert.match(migration, /where h\.correlation_id = new\.correlation_id/);
  });

  test('the trigger fires before insert, where it can still refuse', () => {
    assert.match(migration, /create trigger derive_handoff_depth\s*\n\s*before insert on ai\.handoffs/);
  });
});

describe('E. an overspent run is recorded, then forced terminal', () => {
  test('the trigger writes budget_exceeded rather than rejecting the write', () => {
    // Refusing the UPDATE would reject the write that records what was
    // actually spent. Unrecorded spend is the worse failure: the money is gone
    // either way and only one version leaves evidence.
    assert.match(migration, /new\.status\s+:= 'budget_exceeded';/);
    assert.ok(
      !/raise exception[\s\S]{0,200}ceiling exceeded/.test(migration),
      'the ceiling trigger raises instead of recording the true usage',
    );
  });

  test('and it overrides a run claiming success', () => {
    // A run cut off at its ceiling did not succeed. Letting the claim stand
    // would be the false-completion problem one layer down.
    assert.match(migration, /before insert or update on ai\.agent_runs/);
  });

  test('an agent with no row is not given an invented ceiling', () => {
    assert.match(migration, /if v_max_steps is null then\s*\n\s*return new;/);
  });
});
