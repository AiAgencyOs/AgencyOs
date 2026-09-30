import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { readAiCostBuckets } from './ai-cost-queries';
import { computeMargin, type Margin } from './margin';

export { computeMargin, MARGIN_LABEL, type Margin, type MarginInputs } from './margin';

/**
 * Margin on the project report. Decision: reversed by the owner on
 * 2026-09-29 — earlier passes left the money figures side by side with
 * "no margin is computed"; the owner has asked for one, labelled a
 * cash-basis estimate. Time costed by decision E2 of 2026-09-30.
 *
 *   margin = paid revenue − (expenses recorded + AI cost + time cost)
 *
 * PAID, not invoiced: cash basis means what has actually arrived. Expenses
 * are `finance.expenses` rows on the project; AI cost is what the runtime
 * recorded on `ai.agent_runs` attributed to the project (`cost_minor`,
 * never a rate applied here). Time cost is `projects.time_log_totals_by_project`'s
 * `cost_minor`: each log priced at the rate in force for its person ON THE
 * DAY OF THE LOG (`core.member_cost_rates`, via `projects.time_log_costs`),
 * so a rate change never rewrites an earlier month. Hours with no rate on
 * their day come back as `uncosted_hours` and are shown, not zeroed. The
 * arithmetic is `computeMargin` in margin.ts, a pure function the test
 * pins; this reader only gathers the sums. The views are security_invoker:
 * a reader who may not see rates sees every hour as uncosted.
 *
 * Currency: expenses and paid amounts are in the project's currency; AI
 * cost and time cost are recorded in INR. Where they differ the INR terms
 * are still subtracted (the report already prints them in INR) and the
 * label says so.
 */

/** The sums for one project, each under the reader's own RLS. Any failed read refuses. */
export async function readProjectMargin(projectId: string): Promise<Margin> {
  const supabase = await createClient();

  const [paidRes, expensesRes, runsRes, timeRes] = await Promise.all([
    supabase.schema('finance').from('invoices').select('verified_minor, status').eq('project_id', projectId),
    supabase.schema('finance').from('expenses').select('amount_minor').eq('project_id', projectId),
    // The totals function, not the runs table (see ai-cost-queries.ts): the same margin for every role that may read it.
    readAiCostBuckets().then((data) => ({ data: data.filter((b) => b.project_id === projectId), error: null as null })),
    supabase.schema('projects').from('time_log_totals_by_project').select('cost_minor, uncosted_hours').eq('project_id', projectId),
  ]);
  if (paidRes.error) unreadable('readProjectMargin.invoices', paidRes.error);
  if (expensesRes.error) unreadable('readProjectMargin.expenses', expensesRes.error);
  if (timeRes.error) unreadable('readProjectMargin.timeCost', timeRes.error);

  // Cash basis on the ONE verified basis (verified-basis.ts): what a person confirmed, not what was recorded.
  const paidMinor = (paidRes.data ?? []).reduce((n, i) => n + (i.status === 'void' ? 0 : i.verified_minor), 0);
  const expensesMinor = (expensesRes.data ?? []).reduce((n, e) => n + e.amount_minor, 0);
  const aiCostMinor = (runsRes.data ?? []).reduce((n, r) => n + r.cost_minor, 0);
  const timeCostMinor = (timeRes.data ?? []).reduce((n, t) => n + Number(t.cost_minor ?? 0), 0);
  const uncostedHours = Math.round((timeRes.data ?? []).reduce((n, t) => n + Number(t.uncosted_hours ?? 0), 0) * 100) / 100;

  return computeMargin({ paidMinor, expensesMinor, aiCostMinor, timeCostMinor, uncostedHours });
}
