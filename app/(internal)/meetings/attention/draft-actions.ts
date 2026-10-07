'use server';

import { revalidatePath } from 'next/cache';

import { discardSchedulingDraft, sendSchedulingDraft } from '@/modules/crm/p1r-scheduling-drafts';
import type { FormState } from '@/modules/identity/types';

/** A person sends a drafted scheduling message (possibly edited), or discards it with a reason. Nothing here runs without a signed-in person pressing the button. */
export async function sendDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await sendSchedulingDraft(String(formData.get('draftId') ?? ''), String(formData.get('body') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/meetings/attention');
  return { status: 'success', message: result.data };
}

export async function discardDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await discardSchedulingDraft(String(formData.get('draftId') ?? ''), String(formData.get('reason') ?? '').trim());
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/meetings/attention');
  return { status: 'success', message: result.data };
}
