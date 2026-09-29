import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { leadScoreReasonsSchema, type LeadScoreReasonRow } from './lead-score-schema';

/**
 * ADM-88 — Decision: reversed by the owner on 2026-09-29. The stored score
 * beside its reasons: what the leads list sorts by and the Lead 360 expands.
 * A row whose reasons do not parse is shown as unscored rather than as a
 * number with nothing under it — the constraint makes that impossible to
 * store, and this makes it impossible to render.
 */

export type LeadScoreSummary = {
  score: number;
  reasons: LeadScoreReasonRow[];
  scoredAt: string;
};

export type LeadScoreDetail = LeadScoreSummary & {
  inputs: Record<string, unknown>;
};

function summaryOf(row: { score: number | null; score_reasons: unknown; scored_at: string | null }): LeadScoreSummary | null {
  if (row.score === null || row.scored_at === null) return null;
  const reasons = leadScoreReasonsSchema.safeParse(row.score_reasons);
  if (!reasons.success) return null;
  return { score: row.score, reasons: reasons.data, scoredAt: row.scored_at };
}

export async function readLeadScores(leadIds: readonly string[]): Promise<Map<string, LeadScoreSummary>> {
  const scores = new Map<string, LeadScoreSummary>();
  if (leadIds.length === 0) return scores;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, score, score_reasons, scored_at')
    .in('id', [...leadIds]);
  if (error) unreadable('readLeadScores', error);

  for (const row of data ?? []) {
    const summary = summaryOf(row);
    if (summary) scores.set(row.id, summary);
  }
  return scores;
}

export async function readLeadScore(leadId: string): Promise<LeadScoreDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, score, score_reasons, score_inputs, scored_at')
    .eq('id', leadId)
    .maybeSingle();
  if (error) unreadable('readLeadScore', error);
  if (!data) return null;

  const summary = summaryOf(data);
  if (!summary) return null;
  const inputs = typeof data.score_inputs === 'object' && data.score_inputs !== null && !Array.isArray(data.score_inputs) ? (data.score_inputs as Record<string, unknown>) : {};
  return { ...summary, inputs };
}
