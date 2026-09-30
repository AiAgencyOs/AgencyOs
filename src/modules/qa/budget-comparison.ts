/**
 * Budgets against results — SCR-048, bucket F. Pure: the latest result per
 * metric against its budget, in the budget's own direction. A report, not a
 * verdict the database stores.
 */

export type PerformanceBudgetRow = { id: string; metric: string; target: number; unit: string; lowerIsBetter: boolean };
export type MetricResultRow = { id: string; runId: string; metric: string; value: number; unit: string; recordedAt: string };

export type BudgetComparison = PerformanceBudgetRow & {
  latest: { value: number; unit: string; runId: string; recordedAt: string } | null;
  /** 'within' | 'over' | 'unmeasured'. */
  standing: 'within' | 'over' | 'unmeasured';
};

/** Pure: the latest result per metric against its budget. */
export function compareToBudgets(budgets: readonly PerformanceBudgetRow[], results: ReadonlyMap<string, MetricResultRow[]>): BudgetComparison[] {
  const latestByMetric = new Map<string, MetricResultRow>();
  for (const list of results.values()) {
    for (const r of list) {
      const current = latestByMetric.get(r.metric);
      if (!current || r.recordedAt > current.recordedAt) latestByMetric.set(r.metric, r);
    }
  }
  return budgets.map((b) => {
    const latest = latestByMetric.get(b.metric);
    if (!latest) return { ...b, latest: null, standing: 'unmeasured' };
    const over = b.lowerIsBetter ? latest.value > b.target : latest.value < b.target;
    return { ...b, latest: { value: latest.value, unit: latest.unit, runId: latest.runId, recordedAt: latest.recordedAt }, standing: over ? 'over' : 'within' };
  });
}
