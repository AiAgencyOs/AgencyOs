'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { assignLead } from './assign-service';

/** Hands a lead (and so its conversation) to a person — SCR-057. */
export async function setLeadOwnerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const assignee = String(formData.get('assigneeId') ?? '').trim();

  const result = await assignLead({ leadId, assigneeId: assignee === '' ? null : assignee });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/communication');
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/meetings');
  return { status: 'success', message: result.data.assigneeId ? 'Handed over.' : 'Assignment cleared.' };
}
