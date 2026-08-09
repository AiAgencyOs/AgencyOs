import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  configurePaymentPlanSchema,
  splitBudget,
} from '../src/modules/projects/schema.ts';

/**
 * The payment plan is the source of truth for what gets invoiced, so these
 * tests are about one property above all others: **no plan may lose or invent
 * money.** Whatever the split, the milestone amounts must sum to exactly the
 * budget, in integer minor units.
 *
 * No plan is hard-coded anywhere in the system, so none is privileged here
 * either — 30/20/30/20 gets no more attention than 5/10/30/20/35.
 */

/** Splits the business actually uses, plus the awkward ones. */
const PLANS: Record<string, number[]> = {
  '30/20/30/20': [30, 20, 30, 20],
  '5/10/30/20/35': [5, 10, 30, 20, 35],
  '50/50': [50, 50],
  '33.33/33.33/33.34': [33.33, 33.33, 33.34],
  '100': [100],
  '10 x 10': [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
  '0.01 tail': [99.99, 0.01],
};

/** Budgets chosen to make rounding visible: 10L, an odd number, and a prime. */
const BUDGETS = [100_000_00, 999_99, 1_000_003, 7, 0];

describe('splitBudget', () => {
  for (const [name, percents] of Object.entries(PLANS)) {
    for (const budget of BUDGETS) {
      test(`${name} of ${budget} minor units sums to exactly the budget`, () => {
        const amounts = splitBudget(budget, percents);

        assert.equal(amounts.length, percents.length);
        assert.equal(
          amounts.reduce((sum, a) => sum + a, 0),
          budget,
          'milestone amounts must sum to the budget with no drift',
        );
        for (const amount of amounts) {
          assert.ok(Number.isInteger(amount), `${amount} must be an integer minor amount`);
          assert.ok(amount >= 0, `${amount} must not be negative`);
        }
      });
    }
  }

  test('each share is proportional to its percentage, remainder aside', () => {
    // 30/20/30/20 of ₹10,00,000 is the plan the business quotes most often.
    assert.deepEqual(splitBudget(100_000_000, [30, 20, 30, 20]), [
      30_000_000, 20_000_000, 30_000_000, 20_000_000,
    ]);
  });

  test('rounding remainder lands on the final milestone, never nowhere', () => {
    // 33.33/33.33/33.34 of ₹1.00 cannot divide evenly.
    const amounts = splitBudget(100, [33.33, 33.33, 33.34]);
    assert.deepEqual(amounts, [33, 33, 34]);
    assert.equal(amounts.reduce((s, a) => s + a, 0), 100);
  });

  test('an empty plan returns nothing rather than throwing', () => {
    assert.deepEqual(splitBudget(1000, []), []);
  });
});

describe('configurePaymentPlanSchema', () => {
  const projectId = '00000000-0000-4000-8000-000000000001';
  const plan = (percents: number[]) => ({
    projectId,
    items: percents.map((percent, i) => ({ name: `Milestone ${i + 1}`, percent })),
  });

  for (const [name, percents] of Object.entries(PLANS)) {
    test(`accepts ${name}`, () => {
      assert.equal(configurePaymentPlanSchema.safeParse(plan(percents)).success, true);
    });
  }

  test('rejects a plan totalling less than 100', () => {
    assert.equal(configurePaymentPlanSchema.safeParse(plan([30, 20, 30])).success, false);
  });

  test('rejects a plan totalling more than 100', () => {
    assert.equal(configurePaymentPlanSchema.safeParse(plan([50, 40, 30])).success, false);
  });

  test('rejects a zero-percent milestone', () => {
    assert.equal(configurePaymentPlanSchema.safeParse(plan([0, 100])).success, false);
  });

  test('rejects a negative milestone', () => {
    assert.equal(configurePaymentPlanSchema.safeParse(plan([-10, 110])).success, false);
  });

  test('rejects a single milestone over 100%', () => {
    assert.equal(configurePaymentPlanSchema.safeParse(plan([110])).success, false);
  });

  test('rejects an empty plan', () => {
    assert.equal(configurePaymentPlanSchema.safeParse(plan([])).success, false);
  });

  test('rejects an unnamed milestone', () => {
    const result = configurePaymentPlanSchema.safeParse({
      projectId,
      items: [{ name: '   ', percent: 100 }],
    });
    assert.equal(result.success, false);
  });

  test('a plan whose float sum overshoots 100 is still accepted', () => {
    // 0.01 + 64.04 + 35.95 is 100.00000000000001 in IEEE 754. A naive
    // `sum === 100` would reject a plan that is exactly right; the refine
    // scales to integer basis points before comparing, so it does not.
    const percents = [0.01, 64.04, 35.95];
    assert.notEqual(percents.reduce((sum, p) => sum + p, 0), 100);
    assert.equal(configurePaymentPlanSchema.safeParse(plan(percents)).success, true);
  });
});
