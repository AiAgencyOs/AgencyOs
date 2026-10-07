'use server';

import { revalidatePath } from 'next/cache';

import { setOverlapRule } from '@/modules/crm/p1r-scheduling-drafts';
import type { FormState } from '@/modules/identity/types';

/** Switch the overlap guard on or off for the organisation, with the reason kept. The database says who may; the refusal is shown as written. */
export async function setOverlapRuleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const prevent = String(formData.get('prevent') ?? '') === 'on';
  const result = await setOverlapRule(prevent, String(formData.get('reason') ?? '').trim());
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/meetings/policy');
  return { status: 'success', message: result.data };
}
