import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compareRuns } from '../src/modules/qa/baseline.ts';
import { describeCron, nextCronOccurrence, parseCron } from '../src/modules/qa/cron.ts';
import { compareToBudgets } from '../src/modules/qa/budget-comparison.ts';
import { bugTrend } from '../src/modules/qa/bug-trend.ts';

/**
 * A run opens and closes — SCR-046/048, bucket F (stream F-E).
 *
 * A test run has a life: opened against a build, closed once with its final
 * counts (blocked is its own column and adds up), rerun by pointing a new
 * run at the old one. Evidence stays evidence: the only update the trigger
 * admits is the one an open run makes. Schedules are cron expressions the
 * tick reads with one pure parser; a baseline comparison and a budget
 * comparison are pure too, and are pinned here.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20261001140000_a_release_is_paid_for_and_a_run_has_a_life.sql');

function body(fn: string): string {
  const start = MIGRATION.indexOf(`create or replace function ${fn}`);
  assert.ok(start >= 0, `${fn} is in the migration`);
  return MIGRATION.slice(start, MIGRATION.indexOf('$$;', MIGRATION.indexOf('as $$', start)));
}

describe('A. the run lifecycle in the database', () => {
  test('status, timestamps, blocked and rerun_of are columns; the counts still add up', () => {
    assert.match(MIGRATION, /add column if not exists status\s+text not null default 'closed'/);
    assert.match(MIGRATION, /add column if not exists blocked\s+int not null default 0/);
    assert.match(MIGRATION, /add column if not exists rerun_of\s+uuid references qa\.test_runs\(id\)/);
    assert.match(MIGRATION, /check \(passed \+ failed \+ skipped \+ blocked = total\)/);
    assert.match(MIGRATION, /check \(status <> 'closed' or ended_at is not null\)/);
    assert.match(MIGRATION, /core\.enforce_parent_org\('rerun_of', 'qa\.test_runs'\)/);
  });

  test('evidence is still never edited: the trigger admits exactly the transition out of open', () => {
    const fn = body('qa.refuse_test_run_rewrite()');
    assert.match(fn, /if old\.status = 'open' and new\.status in \('open', 'closed'\) then\s*\n\s*return new;/);
    assert.match(fn, /a test run is evidence and is never edited/);
  });

  test('open writes zero counts and started_at; close writes the sum once; rerun refuses when nothing failed', () => {
    const open = body('qa.open_test_run(');
    assert.match(open, /0, 0, 0, 0, 0, v_actor,\s*\n\s*'open', now\(\), p_rerun_of/);
    assert.match(open, /'test_run\.opened'/);
    const close = body('qa.close_test_run(');
    assert.match(close, /if v_run\.status <> 'open' then\s*\n\s*return query select 'not_open'::text; return;/);
    assert.match(close, /total\s+= p_passed \+ p_failed \+ p_skipped \+ p_blocked/);
    assert.match(close, /'test_run\.closed'/);
    const rerun = body('qa.rerun_test_run(p_run_id uuid)');
    assert.match(rerun, /if v_run\.failed = 0 and v_run\.blocked = 0 then\s*\n\s*return query select 'nothing_failed'::text/);
    assert.match(rerun, /qa\.open_test_run\(v_run\.deliverable_id, v_run\.suite, v_run\.id/);
  });

  test('the tick fires a schedule under a lock and only when due; the parser lives in the app', () => {
    const fn = body('qa.fire_suite_schedule(p_schedule_id uuid, p_next_run_at timestamptz)');
    assert.match(fn, /for update skip locked/);
    assert.match(fn, /v_s\.next_run_at > now\(\) then\s*\n\s*return query select 'not_due'::text/);
    assert.match(fn, /'suite_schedule\.fired'/);
    assert.match(MIGRATION, /revoke all on function qa\.fire_suite_schedule\(uuid, timestamptz\) from public, anon, authenticated;/);
    assert.match(MIGRATION, /grant execute on function qa\.fire_suite_schedule\(uuid, timestamptz\) to service_role;/);
  });

  test('every new table is tenanted, forced and frozen', () => {
    for (const table of ['qa.retest_assignments', 'qa.performance_budgets', 'qa.metric_results', 'qa.stability_incidents', 'qa.suite_schedules']) {
      assert.match(MIGRATION, new RegExp(`alter table ${table.replace('.', '\\.')} enable row level security;`), `${table} enables RLS`);
      assert.match(MIGRATION, new RegExp(`alter table ${table.replace('.', '\\.')} force row level security;`), `${table} forces RLS`);
      assert.match(MIGRATION, new RegExp(`freeze_org_${table.split('.')[1]}`), `${table} freezes organization_id`);
    }
  });
});

describe('B. cron, parsed once', () => {
  test('five fields, ranges, lists and steps; garbage is null', () => {
    assert.ok(parseCron('0 2 * * *'));
    assert.ok(parseCron('*/15 9-17 * * 1-5'));
    assert.equal(parseCron('0 2 * *'), null);
    assert.equal(parseCron('60 2 * * *'), null);
    assert.equal(parseCron('0 2 * * mon'), null);
    assert.deepEqual([...parseCron('0 0 * * 7')!.weekday], [0]);
  });

  test('the next occurrence is computed in the named zone', () => {
    // 02:00 in Kolkata is 20:30 UTC the previous day.
    const after = new Date('2026-09-30T12:00:00Z');
    const next = nextCronOccurrence('0 2 * * *', after, 'Asia/Kolkata');
    assert.equal(next?.toISOString(), '2026-09-30T20:30:00.000Z');
    const weekday = nextCronOccurrence('30 9 * * 1', after, 'UTC');
    assert.equal(weekday?.toISOString(), '2026-10-05T09:30:00.000Z');
    assert.equal(nextCronOccurrence('0 0 31 2 *', after, 'UTC'), null);
  });

  test('and is described in words', () => {
    assert.equal(describeCron('0 2 * * *'), 'every day at 02:00');
    assert.equal(describeCron('30 9 * * 1'), 'Monday at 09:30');
  });
});

describe('C. the comparisons are pure', () => {
  const base = { id: 'a', suite: 'regression', passed: 8, failed: 2, skipped: 0, blocked: 0, total: 10, executedAt: '2026-09-01T00:00:00Z' };
  const cand = { id: 'b', suite: 'regression', passed: 9, failed: 0, skipped: 0, blocked: 1, total: 10, executedAt: '2026-09-02T00:00:00Z' };

  test('baseline vs candidate: regressed, recovered, pass-rate delta, metric delta', () => {
    const c = compareRuns(
      base,
      cand,
      [{ planItemId: 'x', outcome: 'passed' }, { planItemId: 'y', outcome: 'failed' }],
      [{ planItemId: 'x', outcome: 'failed' }, { planItemId: 'y', outcome: 'passed' }, { planItemId: 'z', outcome: 'passed' }],
      [{ metric: 'LCP', value: 2.5, unit: 's' }],
      [{ metric: 'LCP', value: 2.0, unit: 's' }],
    );
    assert.equal(c.regressed, 1);
    assert.equal(c.recovered, 1);
    assert.equal(c.cases.find((x) => x.planItemId === 'z')?.change, 'new');
    assert.equal(c.passRate.delta, 10);
    assert.equal(c.metrics[0]?.delta, -0.5);
    assert.equal(c.metrics[0]?.deltaPercent, -20);
  });

  test('budgets: the latest result decides, in the budget\'s own direction', () => {
    const results = new Map([
      ['r1', [{ id: '1', runId: 'r1', metric: 'LCP', value: 3, unit: 's', recordedAt: '2026-09-01T00:00:00Z' }]],
      ['r2', [{ id: '2', runId: 'r2', metric: 'LCP', value: 2, unit: 's', recordedAt: '2026-09-02T00:00:00Z' }, { id: '3', runId: 'r2', metric: 'score', value: 80, unit: 'pts', recordedAt: '2026-09-02T00:00:00Z' }]],
    ]);
    const out = compareToBudgets(
      [
        { id: 'b1', metric: 'LCP', target: 2.5, unit: 's', lowerIsBetter: true },
        { id: 'b2', metric: 'score', target: 90, unit: 'pts', lowerIsBetter: false },
        { id: 'b3', metric: 'TTFB', target: 600, unit: 'ms', lowerIsBetter: true },
      ],
      results,
    );
    assert.equal(out[0]?.standing, 'within');
    assert.equal(out[1]?.standing, 'over');
    assert.equal(out[2]?.standing, 'unmeasured');
  });

  test('the bug trend counts raised and settled per week and open at each week\'s end', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const points = bugTrend(
      [
        { createdAt: '2026-09-22T10:00:00Z', status: 'open', updatedAt: '2026-09-22T10:00:00Z' },
        { createdAt: '2026-09-15T10:00:00Z', status: 'verified', updatedAt: '2026-09-23T10:00:00Z' },
      ],
      now,
      3,
    );
    assert.deepEqual(points.map((p) => p.week), ['2026-09-14', '2026-09-21', '2026-09-28']);
    assert.equal(points[0]?.raised, 1);
    assert.equal(points[1]?.raised, 1);
    assert.equal(points[1]?.settled, 1);
    assert.equal(points[0]?.openAtEnd, 1);
    assert.equal(points[2]?.openAtEnd, 1);
  });
});
