import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { computeBudgetVariance, monthlyCostsFrom, type BudgetVariance } from './budget-variance';

export { computeBudgetVariance, type BudgetVariance, type MonthlyBurn } from './budget-variance';

/**
 * Budget vs actual — decision F5 of 2026-09-30. The sums for one project
 * (the project report) or every project with a budget or a cost (Finance ›
 * Expenses), each under the reader's own RLS; the arithmetic is
 * `computeBudgetVariance`, pure, in budget-variance.ts.
 *
 * Three cost streams, dated so the monthly burn can be drawn:
 *   expenses  — finance.expenses on the project, by incurred_on
 *   AI cost   — ai.agent_runs attributed to the project (cost_minor, what
 *               the runtime recorded; never a rate applied here), by the
 *               run's created_at
 *   time cost — projects.time_log_costs, each log priced at its person's
 *               rate on the day of the log, by logged_on; rows with no rate
 *               are counted as uncosted hours, never as zero cost
 *
 * Month keys are the ISO date's first seven characters: expenses and logs
 * carry a calendar date already; a run's timestamp is cut the same way,
 * which is UTC — one hour either side of midnight on the last day of a
 * month can land a run in the neighbouring month, and the report says
 * "by month, UTC" for that reason.
 */

type AttributedRun = { project_id: string | null; cost_minor: number | null; created_at: string };
type CostedLog = { project_id: string | null; logged_on: string | null; cost_minor: number | null; hours: number | null; rate_missing: boolean | null };

async function readStreams(projectIds: readonly string[] | null) {
  const supabase = await createClient();
  const scoped = <T>(q: T) => q;
  const [expensesRes, runsRes, timeRes] = await Promise.all([
    scoped(
      (() => {
        let q = supabase.schema('finance').from('expenses').select('project_id, amount_minor, incurred_on').not('project_id', 'is', null).limit(20_000);
        if (projectIds) q = q.in('project_id', [...projectIds]);
        return q;
      })(),
    ),
    scoped(
      (() => {
        let q = supabase
          .schema('ai')
          .from('agent_runs')
          .select('project_id, cost_minor, created_at' as never)
          .not('project_id' as never, 'is', null)
          .limit(20_000);
        if (projectIds) q = q.in('project_id' as never, [...projectIds]);
        return q;
      })(),
    ),
    scoped(
      (() => {
        let q = supabase.schema('projects').from('time_log_costs').select('project_id, logged_on, cost_minor, hours, rate_missing').limit(20_000);
        if (projectIds) q = q.in('project_id', [...projectIds]);
        return q;
      })(),
    ),
  ]);
  if (expensesRes.error) unreadable('readBudgetVariance.expenses', expensesRes.error);
  if (runsRes.error) unreadable('readBudgetVariance.aiRuns', runsRes.error);
  if (timeRes.error) unreadable('readBudgetVariance.timeCost', timeRes.error);

  return {
    expenses: (expensesRes.data ?? []) as { project_id: string | null; amount_minor: number; incurred_on: string }[],
    runs: (runsRes.data ?? []) as unknown as AttributedRun[],
    logs: (timeRes.data ?? []) as CostedLog[],
  };
}

function varianceFor(
  projectId: string,
  budgetMinor: number | null,
  streams: Awaited<ReturnType<typeof readStreams>>,
): BudgetVariance {
  const expenses = streams.expenses.filter((e) => e.project_id === projectId);
  const runs = streams.runs.filter((r) => r.project_id === projectId);
  const logs = streams.logs.filter((l) => l.project_id === projectId);

  const expensesMinor = expenses.reduce((n, e) => n + e.amount_minor, 0);
  const aiCostMinor = runs.reduce((n, r) => n + Number(r.cost_minor ?? 0), 0);
  const timeCostMinor = logs.reduce((n, l) => n + (l.rate_missing ? 0 : Number(l.cost_minor ?? 0)), 0);
  const uncostedHours = Math.round(logs.reduce((n, l) => n + (l.rate_missing ? Number(l.hours ?? 0) : 0), 0) * 100) / 100;

  const monthly = monthlyCostsFrom(
    expenses.map((e) => ({ month: e.incurred_on.slice(0, 7), minor: e.amount_minor })),
    runs.map((r) => ({ month: r.created_at.slice(0, 7), minor: Number(r.cost_minor ?? 0) })),
    logs.filter((l) => !l.rate_missing && l.logged_on).map((l) => ({ month: (l.logged_on as string).slice(0, 7), minor: Number(l.cost_minor ?? 0) })),
  );

  return computeBudgetVariance({ budgetMinor, expensesMinor, aiCostMinor, timeCostMinor, uncostedHours, monthly });
}

/** One project's budget vs actual, with its monthly burn. */
export async function readProjectBudgetVariance(projectId: string): Promise<BudgetVariance> {
  const supabase = await createClient();
  const { data: project, error } = await supabase.schema('projects').from('projects').select('budget_minor').eq('id', projectId).maybeSingle();
  if (error) unreadable('readProjectBudgetVariance.project', error);
  const streams = await readStreams([projectId]);
  return varianceFor(projectId, project?.budget_minor ?? null, streams);
}

export type ProjectBudgetVariance = { projectId: string; name: string; currency: string } & BudgetVariance;

/** Every project that has a budget or any recorded cost, for Finance › Expenses. */
export async function readBudgetVarianceByProject(): Promise<ProjectBudgetVariance[]> {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, currency, budget_minor')
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .limit(1000);
  if (error) unreadable('readBudgetVarianceByProject.projects', error);
  const streams = await readStreams(null);

  return (projects ?? [])
    .map((p) => ({ projectId: p.id, name: p.name, currency: p.currency, ...varianceFor(p.id, p.budget_minor, streams) }))
    .filter((v) => v.budgetMinor !== null || v.actualMinor > 0 || v.uncostedHours > 0);
}
