'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { overrideReleasePayment } from './release-payment-service';

/** Decision F1 — the owner's override of the payment gate, from the Release tab. */
export async function overrideReleasePaymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '').trim();
  const result = await overrideReleasePayment({ projectId, reason: String(formData.get('reason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/qa');
  revalidatePath('/production-readiness');
  return { status: 'success', message: 'Override recorded and audited. The payment gate no longer refuses sign-off on this project.' };
}
