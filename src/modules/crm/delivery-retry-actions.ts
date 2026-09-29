'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { retryFailedDelivery } from './delivery-retry-service';

/**
 * SCR-057 — "Retry" on a failed client delivery, from /operations,
 * /communication and the lead's thread. The refusal is the door's own
 * sentence: a closed window or a missing consent is the reason the first
 * send failed, and the retry says so rather than failing quietly again.
 */
export async function retryFailedDeliveryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const messageId = String(formData.get('messageId') ?? '');
  const leadId = String(formData.get('leadId') ?? '');

  const result = await retryFailedDelivery({ messageId });

  revalidatePath('/operations');
  revalidatePath('/communication');
  if (leadId) revalidatePath(`/leads/${leadId}`);
  else revalidatePath('/leads/[leadId]', 'page');

  if (!result.ok) return { status: 'error', message: result.error.message };
  return { status: 'success', message: `Retry ${result.data.attempt} sent to the client.` };
}
