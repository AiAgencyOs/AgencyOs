import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { assembleSpend, type SpendRow, type SpendTable } from './spend-by-project-eval';

/**
 * Settled agent runs grouped by project (`ai.spend_by_project`, owner and ops
 * admin only), with the no-project line kept. A failed read is `unreadable`
 * (G-054): a spend table that rendered nothing on a failed read would claim
 * nothing was spent.
 */
export async function readSpendByProject(): Promise<SpendTable> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').from('spend_by_project').select('project_id, runs, input_tokens, output_tokens, cost_minor');
  if (error) unreadable('readSpendByProject', error);
  const rows: SpendRow[] = (data ?? []).map((r) => ({
    projectId: r.project_id,
    runs: Number(r.runs ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    costMinor: Number(r.cost_minor ?? 0),
  }));
  const ids = rows.map((r) => r.projectId).filter((id): id is string => id !== null);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: projects, error: projectsError } = await supabase.schema('projects').from('projects').select('id, name').in('id', ids);
    if (projectsError) unreadable('readSpendByProject.projects', projectsError);
    for (const p of projects ?? []) names.set(p.id, p.name);
  }
  return assembleSpend(rows, names);
}
