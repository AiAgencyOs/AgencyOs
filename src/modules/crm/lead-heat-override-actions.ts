'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { overrideLeadHeat } from './lead-heat-override-service';

/** Lead 360 — the person's Hot / Warm / Cold label beside the computed one. */
export async function overrideLeadHeatAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const clear = String(formData.get('clear') ?? '') === '1';
  const label = clear ? null : String(formData.get('label') ?? '');
  if (!clear && label !== 'Hot' && label !== 'Warm' && label !== 'Cold') return { status: 'error', message: 'Choose Hot, Warm or Cold.' };

  const result = await overrideLeadHeat({ leadId, label: label as 'Hot' | 'Warm' | 'Cold' | null, reason: String(formData.get('reason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/leads');
  return {
    status: 'success',
    message: result.data.outcome === 'cleared' ? 'Override cleared; the computed label stands. Audited.' : 'Label set beside the computed one. Audited.',
  };
}
