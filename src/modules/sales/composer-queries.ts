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

/**
 * The confirmed billing mode of every deal that already has a project —
 * the composer's GST pre-fill (SCR-012), in two bounded reads rather than
 * one per deal. A deal absent from the result has no project, or a project
 * with no active billing profile: the toggle is manual for it.
 */
export async function listDealBillingModes(opportunityIds: readonly string[]): Promise<Map<string, 'gst' | 'non_gst'>> {
  const modes = new Map<string, 'gst' | 'non_gst'>();
  if (opportunityIds.length === 0) return modes;

  const supabase = await createClient();
  const { data: projects, error: projectError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, opportunity_id')
    .in('opportunity_id', [...opportunityIds])
    .is('deleted_at', null);
  if (projectError) unreadable('listDealBillingModes.projects', projectError);
  const rows = (projects ?? []).filter((p): p is typeof p & { opportunity_id: string } => p.opportunity_id !== null);
  if (rows.length === 0) return modes;

  const { data: profiles, error: profileError } = await supabase
    .schema('finance')
    .from('billing_profiles')
    .select('project_id, mode')
    .in('project_id', rows.map((p) => p.id))
    .eq('status', 'active');
  if (profileError) unreadable('listDealBillingModes.profiles', profileError);

  const modeByProject = new Map<string, string | null>();
  for (const p of profiles ?? []) modeByProject.set(p.project_id, p.mode);
  for (const p of rows) {
    const mode = modeByProject.get(p.id);
    if (mode === 'gst' || mode === 'non_gst') modes.set(p.opportunity_id, mode);
  }
  return modes;
}
