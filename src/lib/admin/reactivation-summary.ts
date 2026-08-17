import 'server-only';

import { createClient } from '@/lib/db/server';

/**
 * The reactivation funnel, at a glance, for the Settings page — G-140/G-141.
 *
 * RLS-scoped: an owner sees their own organization's numbers. Every value is
 * read through the shipped engine rather than a re-implementation — the pilot
 * flag off `core.organizations`, the eligible cohort off `crm.reactivation_priority`
 * (consent-gated, tenant-pinned), the enrolled cohort off the `in_reactivation_pilot`
 * column, and the running nurture off `crm.follow_up_sequences` — so this can
 * never disagree with what actually sends.
 */

export type ReactivationSummary = {
  pilotEnabled: boolean;
  /** Consent-eligible, status-eligible leads — the pool the pilot draws from. */
  eligible: number;
  /** Leads enrolled in the pilot cohort (in_reactivation_pilot). */
  enrolled: number;
  /** Active inactive_lead sequences — leads currently being nurtured. */
  activeSequences: number;
  /** True if the eligible count hit its scan cap (the real number may be higher). */
  eligibleCapped: boolean;
};

const ELIGIBLE_SCAN_CAP = 10_000;

export async function reactivationSummary(): Promise<ReactivationSummary> {
  const supabase = await createClient();

  const { data: org } = await supabase
    .schema('core')
    .from('organizations')
    .select('reactivation_pilot_enabled')
    .limit(1);
  const pilotEnabled = Boolean(org?.[0]?.reactivation_pilot_enabled);

  // Eligibility is whatever the ranking function admits (status + granted
  // whatsapp consent), so it can never drift from the send gate. The org is
  // derived from the caller — an authenticated owner is pinned to their tenant.
  const { data: ranked } = await supabase
    .schema('crm')
    .rpc('reactivation_priority', { p_limit: ELIGIBLE_SCAN_CAP });
  const eligible = Array.isArray(ranked) ? ranked.length : 0;

  const { count: enrolled } = await supabase
    .schema('crm')
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('in_reactivation_pilot', true)
    .is('deleted_at', null);

  const { count: activeSequences } = await supabase
    .schema('crm')
    .from('follow_up_sequences')
    .select('id', { count: 'exact', head: true })
    .eq('situation_key', 'inactive_lead')
    .eq('status', 'active');

  return {
    pilotEnabled,
    eligible,
    enrolled: enrolled ?? 0,
    activeSequences: activeSequences ?? 0,
    eligibleCapped: eligible >= ELIGIBLE_SCAN_CAP,
  };
}
