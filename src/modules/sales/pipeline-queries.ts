import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { OpportunityListItem } from './types';

/**
 * The pipeline with the lead facts a filter needs — SCR-005.
 *
 * An opportunity carries no source or owner of its own: the source is the
 * lead's, and the nearest thing to an owner is the lead's assignee
 * (`crm.leads.assigned_to`) — the same reading the meetings list makes —
 * with the deal's own `owner_id` (whoever opened it) as the fallback. Two
 * reads rather than a cross-schema embed, exactly as `listProposals` does
 * for lead titles; both are RLS-scoped.
 */
export type PipelineOpportunity = OpportunityListItem & {
  owner_id: string | null;
  lead: { source: string; assigned_to: string | null; title: string } | null;
  /** The owner the filter compares against: the lead's assignee, else the deal's opener. */
  ownerId: string | null;
};

export async function listPipelineOpportunities(limit = 200): Promise<PipelineOpportunity[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id, name, stage, currency, value_minor, lead_id, client_account_id, expected_close_on, created_at, owner_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listPipelineOpportunities', error);

  const rows = data ?? [];
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter((id): id is string => id !== null))];

  const leads = new Map<string, { source: string; assigned_to: string | null; title: string }>();
  if (leadIds.length > 0) {
    const { data: leadRows, error: leadError } = await supabase
      .schema('crm')
      .from('leads')
      .select('id, source, assigned_to, title')
      .in('id', leadIds);
    if (leadError) unreadable('listPipelineOpportunities.leads', leadError);
    for (const l of leadRows ?? []) leads.set(l.id, { source: l.source, assigned_to: l.assigned_to, title: l.title });
  }

  return rows.map((r) => {
    const lead = r.lead_id ? (leads.get(r.lead_id) ?? null) : null;
    return { ...r, lead, ownerId: lead?.assigned_to ?? r.owner_id ?? null };
  });
}
