/**
 * Budget vs actual — decision F5 of 2026-09-30 ("budget vs actual reopened").
 *
 * Pure and dependency-free so the test pins it and the project report and
 * Finance › Expenses cannot disagree.
 *
 *   actual   = expenses recorded + AI cost + time cost      (all paise)
 *   variance = budget − actual                              (positive = under)
 *
 * Monthly burn is the same three terms per calendar month (`YYYY-MM`, in
 * the agency's zone, keyed by the caller). Average burn is over the months
 * that carry any cost, never over empty months, so a project that started
 * last week is not "burning" a twelfth of its spend. Months of budget left
 * at that burn is null when nothing has burned or the budget is spent.
 *
 * Time cost is the day-of-log costed figure the margin uses; hours with no
 * rate are carried as `uncostedHours` and reported, never treated as zero.
 */

export type MonthlyCost = {
  /** `YYYY-MM`. */
  month: string;
  expensesMinor: number;
  aiCostMinor: number;
  timeCostMinor: number;
};

export type BudgetVarianceInputs = {
  /** Null when the project has no budget recorded — the variance is then unknowable, not zero. */
  budgetMinor: number | null;
  expensesMinor: number;
  aiCostMinor: number;
  timeCostMinor: number;
  uncostedHours: number;
  monthly: readonly MonthlyCost[];
};

export type MonthlyBurn = MonthlyCost & { totalMinor: number };

export type BudgetVariance = {
  budgetMinor: number | null;
  actualMinor: number;
  expensesMinor: number;
  aiCostMinor: number;
  timeCostMinor: number;
  uncostedHours: number;
  /** budget − actual; null without a budget. */
  varianceMinor: number | null;
  /** variance as a share of budget, one decimal; null without a budget. */
  variancePercent: number | null;
  /** actual as a share of budget, one decimal, may exceed 100; null without a budget. */
  consumedPercent: number | null;
  /** 'under' | 'over' | 'on' (within 1% either way) | 'unknown' (no budget). */
  standing: 'under' | 'over' | 'on' | 'unknown';
  monthly: MonthlyBurn[];
  /** Average of months with any cost, in paise; 0 when none. */
  averageBurnMinor: number;
  /** How many months of the remaining budget the average burn covers; null when unknowable. */
  monthsLeftAtBurn: number | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeBudgetVariance(inputs: BudgetVarianceInputs): BudgetVariance {
  const actualMinor = inputs.expensesMinor + inputs.aiCostMinor + inputs.timeCostMinor;
  const monthly: MonthlyBurn[] = [...inputs.monthly]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, totalMinor: m.expensesMinor + m.aiCostMinor + m.timeCostMinor }));
  const active = monthly.filter((m) => m.totalMinor > 0);
  const averageBurnMinor = active.length > 0 ? Math.round(active.reduce((n, m) => n + m.totalMinor, 0) / active.length) : 0;

  if (inputs.budgetMinor === null || inputs.budgetMinor <= 0) {
    return {
      budgetMinor: inputs.budgetMinor,
      actualMinor,
      expensesMinor: inputs.expensesMinor,
      aiCostMinor: inputs.aiCostMinor,
      timeCostMinor: inputs.timeCostMinor,
      uncostedHours: inputs.uncostedHours,
      varianceMinor: null,
      variancePercent: null,
      consumedPercent: null,
      standing: 'unknown',
      monthly,
      averageBurnMinor,
      monthsLeftAtBurn: null,
    };
  }

  const budget = inputs.budgetMinor;
  const varianceMinor = budget - actualMinor;
  const variancePercent = round1((varianceMinor / budget) * 100);
  const consumedPercent = round1((actualMinor / budget) * 100);
  const standing: BudgetVariance['standing'] = Math.abs(variancePercent) <= 1 ? 'on' : varianceMinor > 0 ? 'under' : 'over';
  const monthsLeftAtBurn = averageBurnMinor > 0 && varianceMinor > 0 ? round1(varianceMinor / averageBurnMinor) : null;

  return {
    budgetMinor: budget,
    actualMinor,
    expensesMinor: inputs.expensesMinor,
    aiCostMinor: inputs.aiCostMinor,
    timeCostMinor: inputs.timeCostMinor,
    uncostedHours: inputs.uncostedHours,
    varianceMinor,
    variancePercent,
    consumedPercent,
    standing,
    monthly,
    averageBurnMinor,
    monthsLeftAtBurn,
  };
}

/** Sums three cost streams into `MonthlyCost` rows by `YYYY-MM` key. */
export function monthlyCostsFrom(
  expenses: readonly { month: string; minor: number }[],
  ai: readonly { month: string; minor: number }[],
  time: readonly { month: string; minor: number }[],
): MonthlyCost[] {
  const byMonth = new Map<string, MonthlyCost>();
  const row = (month: string) => {
    const existing = byMonth.get(month);
    if (existing) return existing;
    const fresh = { month, expensesMinor: 0, aiCostMinor: 0, timeCostMinor: 0 };
    byMonth.set(month, fresh);
    return fresh;
  };
  for (const e of expenses) row(e.month).expensesMinor += e.minor;
  for (const a of ai) row(a.month).aiCostMinor += a.minor;
  for (const t of time) row(t.month).timeCostMinor += t.minor;
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}
