import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { aggregateByDay, aggregateLedger, type AgentUsage, type DailyUsage, type UsageTotals } from './usage-eval';

/**
 * AI usage and cost, from what the runtime actually recorded — G-186.
 *
 * ── what changed, and why it is a correctness fix rather than a speed one ──
 *
 * This read every `ai.agent_runs` and `ai.agent_steps` row with a 10,000-row
 * cap and added them up here. Past that cap the page reported **a partial
 * total as if it were the total**, flagged only by a boolean nobody reading a
 * rupee figure would think to check. A spend figure that silently
 * under-reports is worse than no spend figure.
 *
 * `ai.cost_ledger` is one row per day, per agent, per model, written by
 * `ai.roll_up_run_cost()` as each run settles. A year of one agency's work is
 * a few hundred rows, so the cap stops being a lie the page can tell.
 *
 * ── what the numbers now mean, stated because it is a real difference ─────
 *
 * The ledger counts **settled** runs. A run still in flight is not in it, and
 * was in the old figure — so "runs" is now *runs that finished* rather than
 * *runs that started*, which is the number a spend page is asking for anyway.
 * Every terminal status counts, not only success: a failed run has spent its
 * tokens.
 *
 * RLS-scoped to the caller's organization and readable by owner and ops_admin
 * alone, as the table's own policy has always said. `unreadable()` on a failed
 * read (G-054), because a usage page that renders 0 on a failed read would
 * falsely report "nothing spent".
 */

/**
 * Rows, not runs — one per day/agent/model. A year of heavy use is a few
 * hundred, so this ceiling is headroom rather than a bound anything reaches;
 * it is kept only so a pathological table cannot be read into memory whole.
 */
const CAP = 10_000;

export type UsageView = {
  perAgent: AgentUsage[];
  totals: UsageTotals;
  capped: boolean;
  /** Last 30 days that have a ledger row, oldest first — for the trend chart. Never backfilled with zero days (G-186's "invents nothing" rule). */
  dailyTrend: DailyUsage[];
};

export async function getAgentUsage(): Promise<UsageView> {
  const supabase = await createClient();

  const { data: ledger, error } = await supabase
    .schema('ai')
    .from('cost_ledger')
    .select('day, agent_key, runs, input_tokens, output_tokens, cost_minor')
    .order('day', { ascending: false })
    .limit(CAP);
  if (error) unreadable('getAgentUsage', error);

  const rows = (ledger ?? []).map((r) => ({
    day: r.day as string,
    agent_key: r.agent_key as string,
    runs: Number(r.runs),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cost_minor: Number(r.cost_minor),
  }));

  const { perAgent, totals } = aggregateLedger(rows);
  // The ledger is fetched newest-first (so the CAP keeps the most recent
  // history, not the oldest); the trend chart reads left-to-right, so it
  // takes the most recent 30 calendar days off that same read and re-sorts
  // them chronologically rather than re-querying.
  const recentDays = [...new Set(rows.map((r) => r.day))].sort().slice(-30);
  const dailyTrend = aggregateByDay(rows.filter((r) => recentDays.includes(r.day)));

  return { perAgent, totals, capped: rows.length >= CAP, dailyTrend };
}
