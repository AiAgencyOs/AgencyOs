import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { asRows, firstRow, looseSchema } from '@/lib/p13/loose-client';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { DEFAULT_LEAD_SCORE_WEIGHTS, LEAD_SCORE_WEIGHT_KEYS, leadScoreWeightsProblem, type LeadScoreWeights } from './lead-score';

/**
 * P1-CRM-019 / P1-CRM-020 — the lead-scoring weights an administrator set, read and written through `crm.p1s_lead_score_weights` and
 * `crm.p1s_set_lead_score_weights`. `src/lib/db/types.ts` is stale for these objects, so the calls go through the narrow loose view and what comes back is
 * validated here. A stored set that no longer passes the model's own rule is ignored (the defaults apply) rather than scoring with a set that does not add up.
 */

export type LeadScoreWeightsInForce = { version: number; weights: LeadScoreWeights; source: 'default' | 'saved'; setAt: string | null; reason: string | null };

type Db = Awaited<ReturnType<typeof createClient>>;

function fromRow(row: Record<string, unknown> | null): LeadScoreWeightsInForce {
  const fallback: LeadScoreWeightsInForce = { version: 0, weights: { ...DEFAULT_LEAD_SCORE_WEIGHTS }, source: 'default', setAt: null, reason: null };
  if (!row || typeof row.weights !== 'object' || row.weights === null) return fallback;
  const stored = row.weights as Record<string, unknown>;
  if (leadScoreWeightsProblem(stored) !== null) return fallback;
  return {
    version: Number(row.version) || 0,
    weights: Object.fromEntries(LEAD_SCORE_WEIGHT_KEYS.map((k) => [k, Number(stored[k])])) as LeadScoreWeights,
    source: 'saved',
    setAt: typeof row.setAt === 'string' ? row.setAt : null,
    reason: typeof row.reason === 'string' ? row.reason : null,
  };
}

/** The weights in force for the caller's organization (the defaults when none were saved). A read failure is reported, not answered with the defaults. */
export async function readLeadScoreWeights(supabase?: Db): Promise<LeadScoreWeightsInForce> {
  const db = supabase ?? (await createClient());
  const { data, error } = await looseSchema(db, 'crm').rpc('p1s_lead_score_weights');
  if (error) unreadable('readLeadScoreWeights', error);
  return fromRow(firstRow(data));
}

export type WeightHistoryRow = { version: number; weights: Record<string, unknown>; reason: string; createdAt: string };

export async function listLeadScoreWeightHistory(): Promise<WeightHistoryRow[]> {
  const db = await createClient();
  const { data, error } = await looseSchema(db, 'crm').from('p1s_lead_score_weight_sets').select('version, weights, reason, created_at').order('version', { ascending: false }).limit(50);
  if (error) unreadable('listLeadScoreWeightHistory', error);
  return asRows(data).map((r) => ({ version: Number(r.version), weights: (r.weights ?? {}) as Record<string, unknown>, reason: String(r.reason ?? ''), createdAt: String(r.created_at ?? '') }));
}

const REFUSAL: Record<string, string> = {
  no_actor: 'You are not signed in.',
  not_authorized: 'Only an owner or ops admin may change the scoring weights.',
  reason_required: 'Say why the weights are changing; the reason is kept with the version.',
};

/** `crm.p1s_set_lead_score_weights` (owner / ops admin, versioned, audited). */
export async function setLeadScoreWeights(weights: Record<string, unknown>, reason: string): Promise<Result<{ version: number; unchanged: boolean }>> {
  const problem = leadScoreWeightsProblem(weights);
  if (problem) return err('VALIDATION', problem);
  if (reason.trim().length === 0) return err('VALIDATION', REFUSAL.reason_required ?? 'A reason is required.');
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', REFUSAL.not_authorized ?? 'Not allowed.');
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'crm').rpc('p1s_set_lead_score_weights', { p_weights: weights, p_reason: reason.trim() });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setLeadScoreWeights', detail: error.message }));
    return err('INTERNAL', 'Could not save the weights.');
  }
  const row = firstRow(data);
  const outcome = String(row?.outcome ?? '');
  if (outcome === 'set' || outcome === 'unchanged') return ok({ version: Number(row?.version) || 0, unchanged: outcome === 'unchanged' });
  if (outcome.startsWith('invalid_weights')) return err('VALIDATION', outcome.replace(/^invalid_weights:\s*/, ''));
  return err(outcome === 'not_authorized' || outcome === 'no_actor' ? 'FORBIDDEN' : 'INTERNAL', REFUSAL[outcome] ?? 'The database refused the weights.');
}
