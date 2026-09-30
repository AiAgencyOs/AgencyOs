import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-008 — the person's decision, read beside the computed score. Only the
 * four override columns; the computed score and its reasons come from
 * `lead-score-queries.ts` and are never folded in here, so a page cannot
 * show one number where the PDF asks for two.
 */
export type LeadScoreOverride = {
  score: number;
  reason: string;
  byUserId: string;
  at: string;
};

function overrideOf(row: { score_override: number | null; score_override_reason: string | null; score_override_by: string | null; score_override_at: string | null }): LeadScoreOverride | null {
  if (row.score_override === null || row.score_override_reason === null || row.score_override_by === null || row.score_override_at === null) return null;
  return { score: row.score_override, reason: row.score_override_reason, byUserId: row.score_override_by, at: row.score_override_at };
}

export async function readLeadScoreOverride(leadId: string): Promise<LeadScoreOverride | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('score_override, score_override_reason, score_override_by, score_override_at')
    .eq('id', leadId)
    .maybeSingle();
  if (error) unreadable('readLeadScoreOverride', error);
  return data ? overrideOf(data) : null;
}

export async function readLeadScoreOverrides(leadIds: readonly string[]): Promise<Map<string, LeadScoreOverride>> {
  const overrides = new Map<string, LeadScoreOverride>();
  if (leadIds.length === 0) return overrides;
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, score_override, score_override_reason, score_override_by, score_override_at')
    .in('id', [...leadIds])
    .not('score_override', 'is', null);
  if (error) unreadable('readLeadScoreOverrides', error);
  for (const row of data ?? []) {
    const o = overrideOf(row);
    if (o) overrides.set(row.id, o);
  }
  return overrides;
}
