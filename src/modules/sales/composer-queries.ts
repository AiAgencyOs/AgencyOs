import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';
import { readBillingReadiness } from '@/modules/finance/service';

/**
 * What the quotation composer needs to know about the deal — SCR-012.
 *
 * The GST toggle pre-fills from the project's CONFIRMED billing mode, and a
 * deal only has a project once it was converted; before that there is
 * nothing to read and the toggle stays manual. `finance.billing_profiles`
 * is read through the finance module's own reader rather than a second
 * copy of its query.
 */
export type DealBillingMode = {
  projectId: string | null;
  mode: 'gst' | 'non_gst' | null;
};

export async function readDealBillingMode(opportunityId: string): Promise<DealBillingMode> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id')
    .eq('opportunity_id', opportunityId)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (error) unreadable('readDealBillingMode', error);
  if (!data) return { projectId: null, mode: null };

  const readiness = await readBillingReadiness(data.id, supabase);
  if (!readiness.ok) unreadable('readDealBillingMode.billing', { message: readiness.error.code });
  return { projectId: data.id, mode: readiness.data.mode };
}

export type OpportunityOwner = { opportunityId: string; ownerId: string | null };

export async function readOpportunityOwner(opportunityId: string): Promise<OpportunityOwner> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id, owner_id')
    .eq('id', opportunityId)
    .maybeSingle();
  if (error) unreadable('readOpportunityOwner', error);
  return { opportunityId, ownerId: data?.owner_id ?? null };
}
