import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { computeMargin, type Margin } from './margin';

export { computeMargin, MARGIN_LABEL, type Margin, type MarginInputs } from './margin';

/**
 * Margin on the project report. Decision: reversed by the owner on
 * 2026-09-29 — earlier passes left the money figures side by side with
 * "no margin is computed"; the owner has asked for one, labelled a
 * cash-basis estimate.
 *
 *   margin = paid revenue − (expenses recorded + AI cost)
 *
 * PAID, not invoiced: cash basis means what has actually arrived. Expenses
 * are `finance.expenses` rows on the project; AI cost is what the runtime
 * recorded on `ai.agent_runs` attributed to the project (`cost_minor`,
 * never a rate applied here). Time is NOT costed: no cost-rate column
 * exists anywhere in the schema (searched 2026-09-30: no cost_rate,
 * hourly_rate or rate_minor on any table), so hours logged under decision
 * 4 cannot be turned into money without inventing a rate — the screen
 * says so beside the figure. The arithmetic is `computeMargin` in
 * margin.ts, a pure function the test pins; this reader only gathers the
 * three sums.
 *
 * Currency: expenses and paid amounts are in the project's currency; AI
 * cost is recorded in INR. Where they differ the AI term is still
 * subtracted (the report already prints it in INR) and the label says so.
 */

/** The three sums for one project, each under the reader's own RLS. Any failed read refuses. */
export async function readProjectMargin(projectId: string): Promise<Margin> {
  const supabase = await createClient();

  const [paidRes, expensesRes, runsRes] = await Promise.all([
    supabase.schema('finance').from('invoices').select('paid_minor, status').eq('project_id', projectId),
    supabase.schema('finance').from('expenses').select('amount_minor').eq('project_id', projectId),
    // `project_id` postdates the generated types (see ai-cost-queries.ts), hence the casts.
    supabase.schema('ai').from('agent_runs').select('cost_minor').eq('project_id' as never, projectId),
  ]);
  if (paidRes.error) unreadable('readProjectMargin.invoices', paidRes.error);
  if (expensesRes.error) unreadable('readProjectMargin.expenses', expensesRes.error);
  if (runsRes.error) unreadable('readProjectMargin.aiRuns', runsRes.error);

  const paidMinor = (paidRes.data ?? []).reduce((n, i) => n + (i.status === 'void' ? 0 : i.paid_minor), 0);
  const expensesMinor = (expensesRes.data ?? []).reduce((n, e) => n + e.amount_minor, 0);
  const aiCostMinor = ((runsRes.data ?? []) as { cost_minor: number | null }[]).reduce((n, r) => n + (r.cost_minor ?? 0), 0);

  return computeMargin({ paidMinor, expensesMinor, aiCostMinor, timeCosted: false });
}
