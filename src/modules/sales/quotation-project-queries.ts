import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-011 — the project each deal became, by opportunity id, for the
 * quotations list's project filter. A deal that was never won has none,
 * and the filter offers only the projects that exist.
 */
export type QuotationProject = { projectId: string; projectName: string };

export async function readProjectsForOpportunities(opportunityIds: readonly string[]): Promise<Map<string, QuotationProject>> {
  const out = new Map<string, QuotationProject>();
  if (opportunityIds.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, opportunity_id')
    .in('opportunity_id', [...opportunityIds])
    .is('deleted_at', null);
  if (error) unreadable('readProjectsForOpportunities', error);
  for (const p of data ?? []) if (p.opportunity_id) out.set(p.opportunity_id, { projectId: p.id, projectName: p.name });
  return out;
}
