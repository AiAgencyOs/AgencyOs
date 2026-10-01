'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setBudgetBands } from './budget-bands-service';

/** Settings › Budget bands — one form, one door. */
export async function setBudgetBandsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setBudgetBands({ bandText: String(formData.get('bandText') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/budget-bands');
  revalidatePath('/leads');
  return {
    status: 'success',
    message: result.data.outcome === 'cleared' ? 'Cleared: leads use the starting bands again. Audited.' : `Saved ${result.data.bands} band${result.data.bands === 1 ? '' : 's'}. Audited.`,
  };
}
