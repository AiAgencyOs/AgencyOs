import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { QUALIFICATION_AREAS, type QualificationArea } from './schema';

/**
 * Two reads the Lead 360 lacked — SCR-007 — and the per-version source
 * references the requirements panel lacked — SCR-009.
 *
 * `crm.qualification_coverage` was read only by project onboarding
 * (`projects/service.ts`, to avoid re-asking a paying client what they
 * already said). The sales page never showed it, so the person about to
 * qualify a lead could not see which of Document 09 §9's areas the
 * conversation had already answered. Each row is an area and the client's
 * own sentence — no score, no verdict (ADM-88), and this reader adds none.
 *
 * The disqualification history is `lead_activities` rows of kind
 * `status_change` whose metadata says the move was INTO `disqualified`;
 * `setLeadStatus` writes the reason as the body. The row's own reason
 * column only holds the latest and is cleared on reopen, so a lead that
 * was disqualified twice is only legible here.
 */
export type CoverageRow = { area: QualificationArea; quote: string; createdAt: string };

export type QualificationCoverageView = {
  covered: CoverageRow[];
  missing: QualificationArea[];
  total: number;
};

export async function readQualificationCoverage(leadId: string): Promise<QualificationCoverageView> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('qualification_coverage')
    .select('area, quote, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true });
  if (error) unreadable('readQualificationCoverage', error);

  const known = new Set<string>(QUALIFICATION_AREAS);
  const covered: CoverageRow[] = [];
  const seen = new Set<string>();
  for (const row of data ?? []) {
    if (!known.has(row.area) || seen.has(row.area)) continue;
    seen.add(row.area);
    covered.push({ area: row.area as QualificationArea, quote: row.quote, createdAt: row.created_at });
  }
  const missing = QUALIFICATION_AREAS.filter((a) => !seen.has(a));
  return { covered, missing, total: QUALIFICATION_AREAS.length };
}

export type DisqualificationEntry = {
  id: string;
  reason: string;
  from: string | null;
  occurredAt: string;
  actorId: string | null;
};

export async function listDisqualificationHistory(leadId: string, limit = 20): Promise<DisqualificationEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('lead_activities')
    .select('id, body, metadata, occurred_at, actor_id')
    .eq('lead_id', leadId)
    .eq('kind', 'status_change')
    .eq('metadata->>to', 'disqualified')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listDisqualificationHistory', error);

  return (data ?? []).map((row) => {
    const meta = (row.metadata ?? {}) as { from?: unknown };
    return {
      id: row.id,
      reason: row.body ?? '(no reason recorded)',
      from: typeof meta.from === 'string' ? meta.from : null,
      occurredAt: row.occurred_at,
      actorId: row.actor_id,
    };
  });
}

/**
 * What each requirement version was read from — SCR-009's "source
 * references". `requirement_versions` carries no list of message ids; it
 * carries how many messages the extraction read, the job that produced
 * it, and the confirmation message it was sent to the client in. Those are
 * shown as they are, not padded into a list the row does not hold.
 */
export type RequirementSourceRef = {
  versionId: string;
  sourceMessageCount: number | null;
  sourceJobId: string | null;
  confirmationMessageId: string | null;
};

export async function listRequirementSourceRefs(conversationId: string): Promise<Map<string, RequirementSourceRef>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('requirement_versions')
    .select('id, source_message_count, source_job_id, confirmation_message_id')
    .eq('conversation_id', conversationId);
  if (error) unreadable('listRequirementSourceRefs', error);

  const refs = new Map<string, RequirementSourceRef>();
  for (const row of data ?? []) {
    refs.set(row.id, {
      versionId: row.id,
      sourceMessageCount: row.source_message_count,
      sourceJobId: row.source_job_id,
      confirmationMessageId: row.confirmation_message_id,
    });
  }
  return refs;
}
