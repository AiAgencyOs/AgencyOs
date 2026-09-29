import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import {
  daysQuiet,
  DEFAULT_REACTIVATION_INACTIVE_DAYS,
  OPEN_FOLLOW_UP_STATUSES,
  selectReactivationCohort,
  type ReactivationCohortRow,
} from './reactivation-types';

/**
 * SCR-013 — the reactivation cohort for the Follow-ups screen.
 *
 * Consent is not decided here: the candidates come from
 * `crm.reactivation_priority` (SECURITY DEFINER, pinned to the caller's
 * organisation), which admits only leads whose contact holds a granted
 * WhatsApp consent row and whose relationship admits re-engagement — the
 * same predicate the enrolment gate applies, so the number on the tile is
 * the number the door will accept. This reader then removes anyone with an
 * open follow-up and anyone active inside the window, and joins the lead's
 * own row and the Import batch that created it, if one did.
 *
 * Every read refuses on failure (`unreadable`), never an empty cohort: an
 * empty list here would read as "nobody to reactivate", which is a claim.
 */

/** How many ranked candidates one read considers; beyond it the cohort says it is capped. */
const CANDIDATE_SCAN_CAP = 2000;
/** How many cohort rows are detailed (lead row, import batch) in one read. */
const DETAIL_CAP = 500;

export type ReactivationCohort = {
  rows: ReactivationCohortRow[];
  /** The N the cohort was cut at. */
  inactiveDays: number;
  /** Whether the organisation's reactivation pilot is on — enrolment records a decision either way; only an on pilot sends. */
  pilotEnabled: boolean;
  /** Consent-eligible candidates the ranking admitted, before the quiet/open-sequence cut. */
  candidates: number;
  /** Candidates dropped for having an open follow-up. */
  withOpenFollowUp: number;
  /** Candidates dropped for activity inside the window. */
  recentlyActive: number;
  /** True when a cap was hit and the real cohort may be larger. */
  capped: boolean;
};

export async function listReactivationCohort(
  options: { inactiveDays?: number; now?: Date } = {},
): Promise<ReactivationCohort> {
  const inactiveDays = options.inactiveDays ?? DEFAULT_REACTIVATION_INACTIVE_DAYS;
  const now = options.now ?? new Date();
  const supabase = await createClient();

  const { data: org, error: orgError } = await supabase
    .schema('core')
    .from('organizations')
    .select('reactivation_pilot_enabled')
    .limit(1);
  if (orgError) unreadable('listReactivationCohort.organization', orgError);
  const pilotEnabled = Boolean(org?.[0]?.reactivation_pilot_enabled);

  const { data: ranked, error: rankedError } = await supabase
    .schema('crm')
    .rpc('reactivation_priority', { p_limit: CANDIDATE_SCAN_CAP });
  if (rankedError) unreadable('listReactivationCohort.priority', rankedError);
  const candidates = ranked ?? [];
  const candidateIds = candidates.map((c) => c.lead_id);

  const openIds = new Set<string>();
  if (candidateIds.length > 0) {
    const { data: sequences, error: sequencesError } = await supabase
      .schema('crm')
      .from('follow_up_sequences')
      .select('subject_id')
      .eq('subject_type', 'lead')
      .in('subject_id', candidateIds)
      .in('status', [...OPEN_FOLLOW_UP_STATUSES]);
    if (sequencesError) unreadable('listReactivationCohort.sequences', sequencesError);
    for (const s of sequences ?? []) openIds.add(s.subject_id);
  }

  const cohort = selectReactivationCohort(candidates, openIds, now, inactiveDays);
  const withOpenFollowUp = candidates.filter((c) => openIds.has(c.lead_id)).length;
  const recentlyActive = candidates.length - withOpenFollowUp - cohort.length;
  const detailed = cohort.slice(0, DETAIL_CAP);
  const cohortIds = detailed.map((c) => c.lead_id);

  const base = {
    inactiveDays,
    pilotEnabled,
    candidates: candidates.length,
    withOpenFollowUp,
    recentlyActive,
    capped: candidates.length >= CANDIDATE_SCAN_CAP || cohort.length > DETAIL_CAP,
  };
  if (cohortIds.length === 0) return { ...base, rows: [] };

  const { data: leads, error: leadsError } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, title, status, in_reactivation_pilot, assigned_to, source')
    .in('id', cohortIds)
    .is('deleted_at', null);
  if (leadsError) unreadable('listReactivationCohort.leads', leadsError);
  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));

  const { data: imports, error: importsError } = await supabase
    .schema('crm')
    .from('import_records')
    .select('committed_lead_id, batch_id')
    .in('committed_lead_id', cohortIds);
  if (importsError) unreadable('listReactivationCohort.imports', importsError);
  const batchByLead = new Map<string, string>();
  for (const r of imports ?? []) if (r.committed_lead_id) batchByLead.set(r.committed_lead_id, r.batch_id);

  const labelByBatch = new Map<string, string>();
  const batchIds = [...new Set(batchByLead.values())];
  if (batchIds.length > 0) {
    const { data: batches, error: batchesError } = await supabase
      .schema('crm')
      .from('import_batches')
      .select('id, source_label')
      .in('id', batchIds);
    if (batchesError) unreadable('listReactivationCohort.batches', batchesError);
    for (const b of batches ?? []) labelByBatch.set(b.id, b.source_label);
  }

  const rows: ReactivationCohortRow[] = [];
  for (const c of detailed) {
    const lead = leadById.get(c.lead_id);
    // The ranking admitted it a moment ago; a lead RLS now hides is not
    // ours to list. Skipping it is a fact about visibility, not a swallow.
    if (!lead) continue;
    const batchId = batchByLead.get(c.lead_id) ?? null;
    rows.push({
      leadId: c.lead_id,
      title: lead.title,
      status: lead.status,
      tierName: c.tier_name,
      lastActiveAt: c.last_active_at,
      quietDays: daysQuiet(c.last_active_at, now),
      inPilot: Boolean(lead.in_reactivation_pilot),
      assignedTo: lead.assigned_to,
      phone: c.phone,
      source: lead.source,
      importBatchId: batchId,
      importSourceLabel: batchId ? (labelByBatch.get(batchId) ?? null) : null,
    });
  }
  return { ...base, rows };
}
