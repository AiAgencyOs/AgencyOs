import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * What the agency spent — G-186.
 *
 * ── two findings, and the second is why this was worth fixing ─────────────
 *
 * `ai.cost_ledger` was created on 2026-08-07 with the comment *"nightly
 * rollup; the budget check reads this"*. **Nothing ever wrote a row into it
 * and no budget check read it** — the audit's DB-A, which is G-011's
 * tables-with-no-code problem told about a table that describes money.
 *
 * On its own that argues for deleting the table. What argues for filling it is
 * the page: `getAgentUsage` read **every** run and step row under a 10,000-row
 * cap and added them up in the application, so past that cap it reported **a
 * partial total as if it were the total**. A spend figure that silently
 * under-reports is worse than no spend figure.
 *
 * ── written when it happens, because nightly never comes ──────────────────
 *
 * There is no scheduler — `vercel.json` has no crons, which the same audit
 * recorded as P0-2 — so a rollup waiting for one is a rollup that never runs.
 * The trigger fires on the run itself, on the move INTO a terminal status, and
 * that transition is what makes it exactly once: a settled run is written to
 * again, and every later write would otherwise add its tokens a second time.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION_RAW = read('supabase/migrations/20260902120000_what_the_agency_spent.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const USAGE = codeOnly(read('src/lib/admin/usage.ts'));

describe('A. counted once, and only when it is over', () => {
  test('the trigger fires on the transition into a terminal status', () => {
    assert.match(
      MIGRATION,
      /when \(\s*new\.status in \('succeeded', 'failed', 'cancelled', 'budget_exceeded'\)\s*and old\.status not in \('succeeded', 'failed', 'cancelled', 'budget_exceeded'\)\s*\)/,
    );
  });

  test('every terminal status counts, not only success', () => {
    // A failed run has spent its tokens. So has one killed for its budget. A
    // ledger of successes only would tell an owner their worst month was
    // their cheapest.
    assert.match(MIGRATION_RAW, /a ledger that recorded only the\n-- successes/);
  });

  test('and it is an AFTER trigger on the run, not a nightly job', () => {
    assert.match(MIGRATION, /after update on ai\.agent_runs/);
    assert.match(MIGRATION_RAW, /A rollup that waits for\n-- a scheduler nobody has configured is a rollup that never runs/);
  });
});

describe('B. what it counts, and who says so', () => {
  test('the STEPS are the authority, not the run’s own columns', () => {
    // `succeedRun` writes the usage of the call it was handed; a workflow that
    // ever made two model calls would settle with the second one's figures and
    // the first call's tokens would be paid for and unrecorded.
    assert.match(MIGRATION, /from ai\.agent_steps s\s*\n\s*where s\.run_id = new\.id/);
    assert.match(MIGRATION_RAW, /a workflow\s*\n\s*\* that ever made two model calls would settle with the second one's figures/);
  });

  test('a settled run with no steps falls back to its own columns', () => {
    assert.match(MIGRATION, /if v_steps = 0 then\s*\n\s*v_in\s+:= greatest\(new\.input_tokens, 0\);/);
  });

  test('the backfill uses the same authority, so it agrees with the trigger', () => {
    // A backfill computed differently is a ledger whose old half and new half
    // disagree, and nobody would know which to trust.
    assert.match(MIGRATION, /case when spent\.steps > 0 then spent\.cost_minor else greatest\(r\.cost_minor, 0\) end/);
  });

  test('and the backfill can be applied twice without doubling anything', () => {
    // `do update set` rather than `+`: the conflict clause replaces the day's
    // figures with the recomputed ones.
    const backfill = MIGRATION.slice(MIGRATION.indexOf('insert into ai.cost_ledger ('), MIGRATION.length);
    assert.match(backfill, /on conflict \(organization_id, day, agent_key, model\) do update\s*\n\s*set runs\s+= excluded\.runs,/);
  });

  test('a run with no model is filed as unknown rather than dropped', () => {
    // The column is NOT NULL and a run can die before a model is chosen.
    // Dropping the row would hide the spend it did incur.
    assert.match(MIGRATION, /coalesce\(new\.model, 'unknown'\)/);
  });

  test('negative figures cannot enter it', () => {
    assert.match(MIGRATION, /greatest\(s\.tokens_in, 0\)/);
    assert.match(MIGRATION, /greatest\(s\.cost_minor, 0\)/);
  });
});

describe('C. the day is the agency’s day', () => {
  test('resolved from the organization’s own timezone', () => {
    assert.match(MIGRATION, /at time zone coalesce\(o\.timezone, 'UTC'\)/);
  });

  test('with UTC as the fallback, which is what it ships as', () => {
    // `db:verify:followup` asserts the timezone ships unset, so this is the
    // ordinary case rather than the exceptional one.
    assert.match(MIGRATION_RAW, /falling back to UTC when it is unset — which\n-- it ships as, deliberately/);
  });

  test('an organization that is gone rolls up nothing, and does not raise', () => {
    assert.match(MIGRATION, /if v_day is null then/);
  });
});

describe('D. the page reads the rollup, and says what changed', () => {
  test('it reads cost_ledger and nothing else', () => {
    assert.match(USAGE, /\.from\('cost_ledger'\)/);
    assert.ok(!USAGE.includes("from('agent_steps')"));
    assert.ok(!USAGE.includes("from('agent_runs')"));
  });

  test('a failed read still refuses to render a zero', () => {
    // G-054. A usage page showing ₹0 on a failed read reports "nothing spent",
    // which is a different and much worse statement.
    assert.match(USAGE, /if \(error\) unreadable\('getAgentUsage', error\)/);
  });

  test('and the change in meaning is stated rather than left to be discovered', () => {
    // The ledger counts SETTLED runs; a run in flight was in the old figure.
    assert.match(read('src/lib/admin/usage.ts'), /"runs" is now \*runs that finished\* rather than/);
  });
});

describe('E. the verifier measures deltas, because it runs last in a used tenant', () => {
  const VERIFIER = codeOnly(read('scripts/verify-cost-ledger.mjs'));

  test('the ledger and step totals are compared as movements, not absolutes', () => {
    // The first version compared absolutes. It passed alone and failed in the
    // chain: other scripts settle model-less runs (an `unknown` row that is
    // not this script's) and delete their runs afterwards while the ledger
    // keeps the spend — which is correct, and which makes an absolute
    // comparison a check about other scripts' cleanup. The same
    // fixture-isolation class G-175 recorded.
    assert.match(VERIFIER, /const ledgerAtStart = await ledgerTotal\(\);/);
    assert.match(VERIFIER, /const stepsMoved = \(await settledStepTotal\(\)\) - stepsAtStart;/);
    assert.match(VERIFIER, /\(await unknownTotal\(\)\) - unknownAtStart === 11/);
    // And the bucket is SUMMED rather than read as one row: it is keyed by day
    // as well as by agent and model, and this script moves the agency to UTC+14
    // halfway through, so a later run lands on a different calendar day and
    // makes a second row. Reading "the" row compared two different days —
    // green alone, red in the chain.
    assert.match(VERIFIER, /const unknownTotal = async \(\) =>/);
  });

  test('and it returns the agency timezone to unset, which a later script asserts', () => {
    assert.match(VERIFIER, /organizations\?id=eq\.\$\{ORG\}`, \{ timezone: null \}/);
  });

  test('the timezone check is made able to fail, rather than passing on a coincidence', () => {
    // On UTC, "the agency's day" and "UTC's day" are the same string and the
    // assertion would pass whatever the trigger read.
    assert.match(VERIFIER, /Pacific\/Kiritimati/);
    assert.match(VERIFIER, /const INSTANT = '2026-09-02T20:00:00\.000Z';/);
  });
});
