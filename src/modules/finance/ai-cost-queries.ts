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

type AttributedRun = {
  project_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_minor: number;
};

export async function readAiCostByProject(): Promise<ProjectAiCost[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('project_id, input_tokens, output_tokens, cost_minor' as never)
    .not('project_id' as never, 'is', null)
    .limit(10_000);

  if (error) unreadable('readAiCostByProject', error);

  const byProject = new Map<string, ProjectAiCost>();
  for (const r of (data ?? []) as unknown as AttributedRun[]) {
    if (!r.project_id) continue;
    const row = byProject.get(r.project_id) ?? { projectId: r.project_id, runs: 0, inputTokens: 0, outputTokens: 0, costMinor: 0 };
    row.runs += 1;
    row.inputTokens += Number(r.input_tokens ?? 0);
    row.outputTokens += Number(r.output_tokens ?? 0);
    row.costMinor += Number(r.cost_minor ?? 0);
    byProject.set(r.project_id, row);
  }
  return [...byProject.values()];
}
