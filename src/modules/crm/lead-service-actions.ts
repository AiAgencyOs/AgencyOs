'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setLeadService } from './lead-service-service';

/** SCR-006 — the Lead 360 information card's service field. */
export async function setLeadServiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const result = await setLeadService({ leadId, service: String(formData.get('service') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/leads');
  return {
    status: 'success',
    message: result.data.service ? `Service set to “${result.data.service}”.` : 'Service cleared.',
  };
}
