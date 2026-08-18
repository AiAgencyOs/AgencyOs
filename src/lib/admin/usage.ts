import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { aggregateUsage, type AgentUsage, type UsageTotals } from './usage-eval';

/**
 * AI usage and cost, from what the runtime actually recorded — `ai.agent_runs`
 * (tokens) and `ai.agent_steps` (cost), both RLS-scoped to the caller's org. No
 * estimate and no rate card: if nothing has run, the answer is empty and the
 * page says so. `unreadable()` on a failed read (G-054), because a usage page
 * that renders 0 on a failed read would falsely report "nothing spent".
 */

const CAP = 10_000;

export type UsageView = { perAgent: AgentUsage[]; totals: UsageTotals; capped: boolean };

export async function getAgentUsage(): Promise<UsageView> {
  const supabase = await createClient();

  const { data: runs, error: runsError } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('agent_key, input_tokens, output_tokens')
    .limit(CAP);
  if (runsError) unreadable('getAgentUsage', runsError);

  // Cost is on the steps; the embedded run carries the agent it belongs to.
  const { data: steps, error: stepsError } = await supabase
    .schema('ai')
    .from('agent_steps')
    .select('cost_minor, agent_runs(agent_key)')
    .limit(CAP);
  if (stepsError) unreadable('getAgentUsage', stepsError);

  const runRows = (runs ?? []).map((r) => ({
    agent_key: r.agent_key as string,
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
  }));
  const stepRows = (steps ?? []).map((s) => ({
    cost_minor: Number(s.cost_minor),
    agent_key: ((s.agent_runs as { agent_key: string } | null)?.agent_key) ?? null,
  }));

  const { perAgent, totals } = aggregateUsage(runRows, stepRows);
  return { perAgent, totals, capped: (runs?.length ?? 0) >= CAP || (steps?.length ?? 0) >= CAP };
}
