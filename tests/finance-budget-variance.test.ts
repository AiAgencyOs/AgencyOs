import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeBudgetVariance, monthlyCostsFrom } from '../src/modules/finance/budget-variance.ts';
import { NO_VENDOR, rollupByVendor } from '../src/modules/finance/vendor-rollup.ts';

/**
 * Budget vs actual — decision F5 of 2026-09-30 ("reopened"), bucket F.
 *
 *   actual   = expenses + AI cost + time cost
 *   variance = budget − actual
 *
 * Pure, so the project report and Finance › Expenses cannot disagree. A
 * project with no budget has an UNKNOWN variance, not a zero one; the burn
 * is averaged over months that carry cost, never over empty months; hours
 * with no rate are reported, never priced at zero.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

describe('computeBudgetVariance', () => {
  test('the three terms add up and the variance is budget minus actual', () => {
    const v = computeBudgetVariance({
      budgetMinor: 100_000_00,
      expensesMinor: 20_000_00,
      aiCostMinor: 5_000_00,
      timeCostMinor: 15_000_00,
      uncostedHours: 0,
      monthly: [],
    });
    assert.equal(v.actualMinor, 40_000_00);
    assert.equal(v.varianceMinor, 60_000_00);
    assert.equal(v.variancePercent, 60);
    assert.equal(v.consumedPercent, 40);
    assert.equal(v.standing, 'under');
  });

  test('over budget is said as over; within one percent is on', () => {
    const over = computeBudgetVariance({ budgetMinor: 1_000_00, expensesMinor: 1_200_00, aiCostMinor: 0, timeCostMinor: 0, uncostedHours: 0, monthly: [] });
    assert.equal(over.standing, 'over');
    assert.equal(over.varianceMinor, -200_00);
    assert.equal(over.consumedPercent, 120);
    const on = computeBudgetVariance({ budgetMinor: 1_000_00, expensesMinor: 995_00, aiCostMinor: 0, timeCostMinor: 0, uncostedHours: 0, monthly: [] });
    assert.equal(on.standing, 'on');
  });

  test('no budget means unknown, not zero', () => {
    const v = computeBudgetVariance({ budgetMinor: null, expensesMinor: 500_00, aiCostMinor: 0, timeCostMinor: 0, uncostedHours: 2, monthly: [] });
    assert.equal(v.varianceMinor, null);
    assert.equal(v.variancePercent, null);
    assert.equal(v.consumedPercent, null);
    assert.equal(v.standing, 'unknown');
    assert.equal(v.actualMinor, 500_00);
    assert.equal(v.uncostedHours, 2);
  });

  test('monthly burn: averaged over months with cost, sorted, and months of budget left at that burn', () => {
    const v = computeBudgetVariance({
      budgetMinor: 10_000_00,
      expensesMinor: 3_000_00,
      aiCostMinor: 500_00,
      timeCostMinor: 500_00,
      uncostedHours: 0,
      monthly: [
        { month: '2026-09', expensesMinor: 2_000_00, aiCostMinor: 500_00, timeCostMinor: 500_00 },
        { month: '2026-07', expensesMinor: 1_000_00, aiCostMinor: 0, timeCostMinor: 0 },
        { month: '2026-08', expensesMinor: 0, aiCostMinor: 0, timeCostMinor: 0 },
      ],
    });
    assert.deepEqual(v.monthly.map((m) => m.month), ['2026-07', '2026-08', '2026-09']);
    assert.equal(v.monthly[2]?.totalMinor, 3_000_00);
    // Two months carry cost (1,000 and 3,000): the empty August does not dilute the burn.
    assert.equal(v.averageBurnMinor, 2_000_00);
    // 6,000 left at 2,000 a month.
    assert.equal(v.monthsLeftAtBurn, 3);
  });

  test('nothing burned, or the budget spent, means no months-left figure', () => {
    const none = computeBudgetVariance({ budgetMinor: 1_000_00, expensesMinor: 0, aiCostMinor: 0, timeCostMinor: 0, uncostedHours: 0, monthly: [] });
    assert.equal(none.monthsLeftAtBurn, null);
    assert.equal(none.averageBurnMinor, 0);
    const spent = computeBudgetVariance({
      budgetMinor: 1_000_00,
      expensesMinor: 1_500_00,
      aiCostMinor: 0,
      timeCostMinor: 0,
      uncostedHours: 0,
      monthly: [{ month: '2026-09', expensesMinor: 1_500_00, aiCostMinor: 0, timeCostMinor: 0 }],
    });
    assert.equal(spent.monthsLeftAtBurn, null);
  });

  test('monthlyCostsFrom folds three streams by month', () => {
    const rows = monthlyCostsFrom(
      [{ month: '2026-09', minor: 100 }, { month: '2026-09', minor: 50 }],
      [{ month: '2026-08', minor: 20 }],
      [{ month: '2026-09', minor: 30 }],
    );
    assert.deepEqual(rows, [
      { month: '2026-08', expensesMinor: 0, aiCostMinor: 20, timeCostMinor: 0 },
      { month: '2026-09', expensesMinor: 150, aiCostMinor: 0, timeCostMinor: 30 },
    ]);
  });
});

describe('the surfaces read the same pure function', () => {
  test('the reader gathers the three streams and calls computeBudgetVariance; it never prices an uncosted hour', () => {
    const reader = read('src/modules/finance/budget-variance-queries.ts');
    assert.match(reader, /from\('expenses'\)/);
    assert.match(reader, /from\('agent_runs'\)/);
    assert.match(reader, /from\('time_log_costs'\)/);
    assert.match(reader, /l\.rate_missing \? 0 : Number\(l\.cost_minor \?\? 0\)/);
    assert.match(reader, /return computeBudgetVariance\(\{ budgetMinor, expensesMinor, aiCostMinor, timeCostMinor, uncostedHours, monthly \}\);/);
  });

  test('the project report and Finance › Expenses both mount it', () => {
    assert.match(read('app/(internal)/projects/[projectId]/reports/page.tsx'), /readProjectBudgetVariance\(projectId\)/);
    assert.match(read('app/(internal)/finance/expenses/page.tsx'), /readBudgetVarianceByProject\(\)/);
    assert.match(read('app/(internal)/finance/expenses/page.tsx'), /title="Budget vs actual"/);
  });
});

describe('vendor / tool rollup', () => {
  test('one line per vendor per currency, largest first, categories collected, blanks named', () => {
    const rows = rollupByVendor([
      { vendor: 'Vercel', currency: 'INR', amountMinor: 2_000_00, category: 'infrastructure', incurredOn: '2026-09-01' },
      { vendor: 'vercel', currency: 'INR', amountMinor: 1_000_00, category: 'tooling', incurredOn: '2026-09-15' },
      { vendor: null, currency: 'INR', amountMinor: 5_000_00, category: 'contractor', incurredOn: '2026-08-01' },
      { vendor: 'Vercel', currency: 'USD', amountMinor: 20_00, category: 'infrastructure', incurredOn: '2026-09-02' },
    ]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.vendor, NO_VENDOR);
    assert.equal(rows[1]?.vendor, 'Vercel');
    assert.equal(rows[1]?.totalMinor, 3_000_00);
    assert.equal(rows[1]?.count, 2);
    assert.deepEqual(rows[1]?.categories, ['infrastructure', 'tooling']);
    assert.equal(rows[1]?.lastIncurredOn, '2026-09-15');
    assert.equal(rows[2]?.currency, 'USD');
  });
});
