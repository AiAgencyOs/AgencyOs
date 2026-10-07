'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { markApprovalExecuted, markApprovalVerified } from './p13-annotation';

/** Form actions for the approval detail page (wiring W7): record that an approved action was carried out, then that it was checked. */
export async function markApprovalExecutedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('requestId') ?? '');
  const result = await markApprovalExecuted(id, String(formData.get('note') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/approvals/${id}`);
  return { status: 'success', message: 'Recorded as executed. It still needs to be verified.' };
}

export async function markApprovalVerifiedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('requestId') ?? '');
  const result = await markApprovalVerified(id, String(formData.get('note') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/approvals/${id}`);
  return { status: 'success', message: 'Recorded as verified.' };
}
