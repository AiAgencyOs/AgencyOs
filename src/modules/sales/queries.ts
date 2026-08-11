import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { OpportunityListItem } from './types';

/** Reads for the sales module. Pure and RLS-scoped. */

const SELECT =
  'id, name, stage, currency, value_minor, lead_id, client_account_id, expected_close_on, created_at';

/** The opportunity for a lead, if one has been opened. */
export async function getOpportunityForLead(leadId: string): Promise<OpportunityListItem | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .select(SELECT)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) unreadable('getOpportunityForLead', error);
  return data;
}

export async function listOpportunities(limit = 100): Promise<OpportunityListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .select(SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listOpportunities', error);
  return data ?? [];
}
