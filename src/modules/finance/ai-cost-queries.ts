import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What the AI spent per project — SCR-055's cost join.
 *
 * `ai.agent_runs.project_id` and `phase` were attributed by migration
 * 20260920020000 (`ai.resolve_run_subject`), and `ai.project_usage_by_phase`
 * answers for ONE project. The expenses screen wants every project at once,
 * so this reads the attributed rows directly under the same RLS
 * (`agent_runs_select`) and sums in memory — the same figures the project
 * page's phase breakdown shows, grouped the other way. `cost_minor` is what
 * the runtime recorded, never a rate card applied here.
 *
 * The two columns postdate the generated Database types (db:types needs
 * Docker — see finance/queries.ts on `receipts`), hence the cast.
 */
export type ProjectAiCost = {
  projectId: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
};

type CostBucket = {
  project_id: string | null;
  agent_key: string;
  month: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_minor: number;
};

/**
 * Every bucket `finance.ai_cost_buckets()` returns — per project, agent and UTC
 * month. The function, not `ai.agent_runs`, is what this reads: the table's
 * policy excludes the finance role (it holds prompts and outputs), so reading
 * it directly made a project's margin differ by the role looking at it. The
 * function carries totals only, for the roles that read money.
 */
export async function readAiCostBuckets(): Promise<CostBucket[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('ai_cost_buckets');
  if (error) unreadable('readAiCostBuckets', error);
  return (data ?? []).map((b) => ({
    project_id: b.project_id,
    agent_key: b.agent_key,
    month: b.month,
    runs: Number(b.runs),
    input_tokens: Number(b.input_tokens),
    output_tokens: Number(b.output_tokens),
    cost_minor: Number(b.cost_minor),
  }));
}

export async function readAiCostByProject(): Promise<ProjectAiCost[]> {
  const buckets = await readAiCostBuckets();
  const byProject = new Map<string, ProjectAiCost>();
  for (const b of buckets) {
    if (!b.project_id) continue;
    const row = byProject.get(b.project_id) ?? { projectId: b.project_id, runs: 0, inputTokens: 0, outputTokens: 0, costMinor: 0 };
    row.runs += b.runs;
    row.inputTokens += b.input_tokens;
    row.outputTokens += b.output_tokens;
    row.costMinor += b.cost_minor;
    byProject.set(b.project_id, row);
  }
  return [...byProject.values()];
}

export type AgentAiCost = { agentKey: string; runs: number; inputTokens: number; outputTokens: number; costMinor: number; projects: number };

/** The same buckets, by agent: SCR-055's "AI/tooling costs" list. Runs with no project count under the agent too. */
export async function readAiCostByAgent(): Promise<AgentAiCost[]> {
  const buckets = await readAiCostBuckets();
  const byAgent = new Map<string, AgentAiCost & { projectIds: Set<string> }>();
  for (const b of buckets) {
    const row = byAgent.get(b.agent_key) ?? { agentKey: b.agent_key, runs: 0, inputTokens: 0, outputTokens: 0, costMinor: 0, projects: 0, projectIds: new Set<string>() };
    row.runs += b.runs;
    row.inputTokens += b.input_tokens;
    row.outputTokens += b.output_tokens;
    row.costMinor += b.cost_minor;
    if (b.project_id) row.projectIds.add(b.project_id);
    byAgent.set(b.agent_key, row);
  }
  return [...byAgent.values()]
    .map(({ projectIds, ...rest }) => ({ ...rest, projects: projectIds.size }))
    .sort((a, b) => b.costMinor - a.costMinor || b.runs - a.runs);
}
