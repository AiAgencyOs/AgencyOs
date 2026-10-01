import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { countPeriods, sumPeriods, type PeriodCounts } from './period-delta';

/**
 * The raw material for a KPI tile's "vs the previous 30 days" chip: rows
 * (or per-day ledger rows) from the last 60 days, counted or summed into two
 * 30-day windows by the pure helpers in `period-delta.ts`. Nothing stored —
 * every figure is derived from timestamps the tables already carry. A failed
 * read throws (`unreadable`), so a broken read never shows as "no change".
 */

const DAYS = 30;
const since = (now: Date) => new Date(now.getTime() - 2 * DAYS * 86_400_000).toISOString();

export type DashboardDeltas = {
  leads: PeriodCounts;
  projects: PeriodCounts;
  revenue: PeriodCounts;
  messages: PeriodCounts;
  runs: PeriodCounts;
};

export async function getDashboardDeltas(now: Date, want: { leads: boolean; projects: boolean; revenue: boolean; usage: boolean }): Promise<DashboardDeltas> {
  const supabase = await createClient();
  const from = since(now);
  const zero: PeriodCounts = { current: 0, previous: 0 };

  const [leads, projects, revenue, messages, runs] = await Promise.all([
    want.leads
      ? supabase.schema('crm').from('leads').select('created_at').is('deleted_at', null).gte('created_at', from)
      : Promise.resolve({ data: [], error: null }),
    want.projects
      ? supabase.schema('projects').from('projects').select('created_at').is('deleted_at', null).gte('created_at', from)
      : Promise.resolve({ data: [], error: null }),
    want.revenue
      ? supabase.schema('finance').from('payments').select('verified_at, amount_minor').eq('status', 'captured').not('verified_at', 'is', null).gte('verified_at', from)
      : Promise.resolve({ data: [], error: null }),
    want.leads
      ? supabase.schema('crm').from('conversation_messages').select('occurred_at').eq('metadata->>direction', 'outbound').gte('occurred_at', from)
      : Promise.resolve({ data: [], error: null }),
    want.usage
      ? supabase.schema('ai').from('cost_ledger').select('day, runs').gte('day', from.slice(0, 10))
      : Promise.resolve({ data: [], error: null }),
  ]);

  for (const [name, r] of [['leads', leads], ['projects', projects], ['revenue', revenue], ['messages', messages], ['runs', runs]] as const) {
    if (r.error) unreadable(`getDashboardDeltas.${name}`, r.error);
  }

  return {
    leads: want.leads ? countPeriods((leads.data ?? []).map((r: { created_at: string }) => r.created_at), now, DAYS) : zero,
    projects: want.projects ? countPeriods((projects.data ?? []).map((r: { created_at: string }) => r.created_at), now, DAYS) : zero,
    revenue: want.revenue ? sumPeriods((revenue.data ?? []).map((r: { verified_at: string | null; amount_minor: number }) => ({ at: r.verified_at, amount: r.amount_minor })), now, DAYS) : zero,
    messages: want.leads ? countPeriods((messages.data ?? []).map((r: { occurred_at: string }) => r.occurred_at), now, DAYS) : zero,
    runs: want.usage ? sumPeriods((runs.data ?? []).map((r: { day: string; runs: number }) => ({ at: `${r.day}T12:00:00Z`, amount: Number(r.runs) })), now, DAYS) : zero,
  };
}

export type AgentActivity = {
  runs: PeriodCounts;
  tokens: PeriodCounts;
  cost: PeriodCounts;
  failed: PeriodCounts;
  /** Failed runs per UTC day (yyyy-mm-dd), last 30 days — the second series on the activity chart. */
  failedByDay: Record<string, number>;
};

/** Agent runs of the last 60 days (capped), split into two 30-day windows. Runs record `failed` as a status, so failures are counted, not guessed. */
export async function getAgentActivity(now: Date): Promise<AgentActivity> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('created_at, status, input_tokens, output_tokens, cost_minor')
    .gte('created_at', since(now))
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) unreadable('getAgentActivity', error);
  const rows = data ?? [];
  const at = (r: { created_at: string }) => r.created_at;
  const failedRows = rows.filter((r) => r.status === 'failed');
  const failedByDay: Record<string, number> = {};
  const cutoff = now.getTime() - DAYS * 86_400_000;
  for (const r of failedRows) {
    if (new Date(r.created_at).getTime() > cutoff) failedByDay[r.created_at.slice(0, 10)] = (failedByDay[r.created_at.slice(0, 10)] ?? 0) + 1;
  }
  return {
    runs: countPeriods(rows.map(at), now, DAYS),
    tokens: sumPeriods(rows.map((r) => ({ at: r.created_at, amount: Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0) })), now, DAYS),
    cost: sumPeriods(rows.map((r) => ({ at: r.created_at, amount: Number(r.cost_minor ?? 0) })), now, DAYS),
    failed: countPeriods(failedRows.map(at), now, DAYS),
    failedByDay,
  };
}
