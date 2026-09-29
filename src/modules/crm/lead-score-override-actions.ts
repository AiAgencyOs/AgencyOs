'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { overrideLeadScore } from './lead-score-override-service';

/** SCR-008 — the Lead 360's "human decision" beside the computed score. */
export async function overrideLeadScoreAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const clear = String(formData.get('clear') ?? '') === '1';
  const raw = String(formData.get('score') ?? '').trim();
  const score = clear ? null : Number(raw);
  if (!clear && (raw === '' || !Number.isInteger(score))) return { status: 'error', message: 'The override is a whole number from 0 to 100.' };

  const result = await overrideLeadScore({ leadId, score, reason: String(formData.get('reason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/leads');
  return {
    status: 'success',
    message: result.data.outcome === 'cleared' ? 'Override cleared; the computed score stands. Audited.' : 'Override recorded beside the computed score. Audited.',
  };
}
