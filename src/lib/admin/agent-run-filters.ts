import 'server-only';

import { PROVIDER_IDS, providerOfModel, type ProviderId } from '@/lib/ai/model-provider';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The project and provider facets for /usage/runs — SCR-065's "run list with
 * project / agent / provider filters". Projects come from the runs' own
 * `project_id` (derived by trigger from the subject, 20260920020000) joined
 * to their names; providers from the adapters' naming rule over the models
 * the recent runs carried (`providerOfModel`). Both over the same recent
 * window the agent/status/model facets use, so the rail never offers a
 * value the list cannot show.
 */

/** How far back the rail looks. */
const FACET_SCAN = 500;

export type RunProjectFacet = { id: string; name: string };

export async function listRunProjectFacets(): Promise<RunProjectFacet[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('project_id')
    .not('project_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(FACET_SCAN);
  if (error) unreadable('listRunProjectFacets', error);

  const ids = [...new Set((data ?? []).map((r) => r.project_id).filter((id): id is string => id !== null))];
  if (ids.length === 0) return [];

  const { data: projects, error: projectsError } = await supabase.schema('projects').from('projects').select('id, name').in('id', ids);
  if (projectsError) unreadable('listRunProjectFacets.projects', projectsError);
  return (projects ?? []).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The providers seen in recent runs' models, in the registry's order. */
export function providerFacetsFrom(models: readonly (string | null)[]): ProviderId[] {
  const seen = new Set<ProviderId>();
  for (const m of models) {
    const p = providerOfModel(m);
    if (p) seen.add(p);
  }
  return PROVIDER_IDS.filter((p) => seen.has(p));
}
