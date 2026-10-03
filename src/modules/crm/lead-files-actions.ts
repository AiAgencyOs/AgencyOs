'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addLeadFile, removeLeadFile } from './lead-files-service';

/** Lead 360 › Files — keep a link on the lead (decision 11). */
export async function addLeadFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const result = await addLeadFile({ leadId, title: String(formData.get('title') ?? ''), url: String(formData.get('url') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message, fieldErrors: result.error.details };
  revalidatePath(`/leads/${leadId}`);
  return { status: 'success', message: 'File added to the lead.' };
}

export async function removeLeadFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const result = await removeLeadFile({ leadId, fileId: String(formData.get('fileId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/leads/${leadId}`);
  return { status: 'success', message: 'File removed from the lead.' };
}
