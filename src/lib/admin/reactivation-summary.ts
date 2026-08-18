import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The reactivation funnel, at a glance, for the Settings page — G-140/G-141.
 *
 * RLS-scoped: an owner sees their own organization's numbers. Every value is
 * read through the shipped engine rather than a re-implementation — the pilot
 * flag off `core.organizations`, the eligible cohort off `crm.reactivation_priority`
 * (consent-gated, tenant-pinned), the enrolled cohort off the `in_reactivation_pilot`
 * column, and the running nurture off `crm.follow_up_sequences` — so this can
 * never disagree with what actually sends.
 *
 * Every read refuses on failure rather than coalescing to a number (G-054). A
 * summary that renders "pilot OFF, 0 eligible, 0 enrolled" because the database
 * did not answer would tell an owner their consent-gated cohort is empty and
 * disabled at the exact moment nothing can be known — the false-calm the whole
 * operations/settings surface is built to never show. `unreadable()` throws so
 * the page renders its cannot-read state instead of the lie.
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

  const { data: org, error: orgError } = await supabase
    .schema('core')
    .from('organizations')
    .select('reactivation_pilot_enabled')
    .limit(1);
  if (orgError) unreadable('reactivationSummary', orgError);
  const pilotEnabled = Boolean(org?.[0]?.reactivation_pilot_enabled);

  // Eligibility is whatever the ranking function admits (status + granted
  // whatsapp consent), so it can never drift from the send gate. The org is
  // derived from the caller — an authenticated owner is pinned to their tenant.
  const { data: ranked, error: rankedError } = await supabase
    .schema('crm')
    .rpc('reactivation_priority', { p_limit: ELIGIBLE_SCAN_CAP });
  if (rankedError) unreadable('reactivationSummary', rankedError);
  const eligible = Array.isArray(ranked) ? ranked.length : 0;

  const { count: enrolled, error: enrolledError } = await supabase
    .schema('crm')
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('in_reactivation_pilot', true)
    .is('deleted_at', null);
  if (enrolledError) unreadable('reactivationSummary', enrolledError);

  const { count: activeSequences, error: activeError } = await supabase
    .schema('crm')
    .from('follow_up_sequences')
    .select('id', { count: 'exact', head: true })
    .eq('situation_key', 'inactive_lead')
    .eq('status', 'active');
  if (activeError) unreadable('reactivationSummary', activeError);

  return {
    pilotEnabled,
    eligible,
    enrolled: enrolled ?? 0,
    activeSequences: activeSequences ?? 0,
    eligibleCapped: eligible >= ELIGIBLE_SCAN_CAP,
  };
}
