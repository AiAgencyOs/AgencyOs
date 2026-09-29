/**
 * Baseline comparison — SCR-048 "Compare against baseline". Pure: two runs
 * of the same suite, their case results and their metric results, and the
 * answer is what changed. No verdict beyond the arithmetic; a regression is
 * a case that passed on the baseline and did not on the candidate, and a
 * metric that moved the wrong way by the caller's own reading of the unit.
 */

export type ComparableRun = {
  id: string;
  suite: string;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
  total: number;
  executedAt: string;
};

export type CaseOutcome = { planItemId: string; outcome: string };
export type MetricOutcome = { metric: string; value: number; unit: string };

export type CaseDelta = { planItemId: string; baseline: string | null; candidate: string | null; change: 'regressed' | 'recovered' | 'unchanged' | 'new' | 'dropped' };
export type MetricDelta = { metric: string; unit: string; baseline: number | null; candidate: number | null; delta: number | null; deltaPercent: number | null };

export type BaselineComparison = {
  baseline: ComparableRun;
  candidate: ComparableRun;
  passRate: { baseline: number | null; candidate: number | null; delta: number | null };
  cases: CaseDelta[];
  regressed: number;
  recovered: number;
  metrics: MetricDelta[];
};

const rate = (r: ComparableRun) => (r.total > 0 ? Math.round((r.passed / r.total) * 1000) / 10 : null);

export function compareRuns(
  baseline: ComparableRun,
  candidate: ComparableRun,
  baselineCases: readonly CaseOutcome[],
  candidateCases: readonly CaseOutcome[],
  baselineMetrics: readonly MetricOutcome[],
  candidateMetrics: readonly MetricOutcome[],
): BaselineComparison {
  const b = new Map(baselineCases.map((c) => [c.planItemId, c.outcome]));
  const c = new Map(candidateCases.map((x) => [x.planItemId, x.outcome]));
  const ids = [...new Set([...b.keys(), ...c.keys()])].sort();
  const cases: CaseDelta[] = ids.map((id) => {
    const before = b.get(id) ?? null;
    const after = c.get(id) ?? null;
    let change: CaseDelta['change'];
    if (before === null) change = 'new';
    else if (after === null) change = 'dropped';
    else if (before === 'passed' && after !== 'passed') change = 'regressed';
    else if (before !== 'passed' && after === 'passed') change = 'recovered';
    else change = 'unchanged';
    return { planItemId: id, baseline: before, candidate: after, change };
  });

  const bm = new Map(baselineMetrics.map((m) => [m.metric, m]));
  const cm = new Map(candidateMetrics.map((m) => [m.metric, m]));
  const metricNames = [...new Set([...bm.keys(), ...cm.keys()])].sort();
  const metrics: MetricDelta[] = metricNames.map((name) => {
    const before = bm.get(name) ?? null;
    const after = cm.get(name) ?? null;
    const delta = before && after ? Math.round((after.value - before.value) * 1000) / 1000 : null;
    const deltaPercent = before && after && before.value !== 0 ? Math.round(((after.value - before.value) / Math.abs(before.value)) * 1000) / 10 : null;
    return { metric: name, unit: after?.unit ?? before?.unit ?? '', baseline: before?.value ?? null, candidate: after?.value ?? null, delta, deltaPercent };
  });

  const bRate = rate(baseline);
  const cRate = rate(candidate);
  return {
    baseline,
    candidate,
    passRate: { baseline: bRate, candidate: cRate, delta: bRate !== null && cRate !== null ? Math.round((cRate - bRate) * 10) / 10 : null },
    cases,
    regressed: cases.filter((x) => x.change === 'regressed').length,
    recovered: cases.filter((x) => x.change === 'recovered').length,
    metrics,
  };
}
