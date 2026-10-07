'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { LEAD_SCORE_WEIGHT_KEYS } from './lead-score';
import { setLeadScoreWeights } from './lead-score-weights';

/** Save a new version of the lead-scoring weights (P1-CRM-020). The door re-validates, requires an admin and audits. */
export async function setLeadScoreWeightsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const weights: Record<string, unknown> = {};
  for (const k of LEAD_SCORE_WEIGHT_KEYS) {
    const raw = String(formData.get(k) ?? '').trim();
    weights[k] = raw === '' ? undefined : Number(raw);
  }
  const result = await setLeadScoreWeights(weights, String(formData.get('reason') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/lead-scoring');
  return { status: 'success', message: result.data.unchanged ? 'Those are already the weights in force; nothing new was saved.' : `Saved as version ${result.data.version}.` };
}
