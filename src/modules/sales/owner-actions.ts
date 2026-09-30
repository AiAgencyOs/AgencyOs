'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setOpportunityOwner } from './owner-service';

/** The composer's sales-owner select — SCR-012. */
export async function setOpportunityOwnerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOpportunityOwner({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    ownerId: String(formData.get('ownerId') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  const leadId = String(formData.get('leadId') ?? '');
  if (leadId) revalidatePath(`/leads/${leadId}`);
  revalidatePath('/sales-funnel');
  return { status: 'success', message: 'Deal owner updated.' };
}
