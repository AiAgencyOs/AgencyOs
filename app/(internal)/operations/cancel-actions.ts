'use server';

import { revalidatePath } from 'next/cache';

import { cancelJob } from '@/lib/observability/cancel';
import type { FormState } from '@/modules/identity/types';

/** SCR-066 — cancel one queued job with a reason. Refusals are surfaced as written; see cancelJob. */
export async function cancelJobAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await cancelJob(String(formData.get('jobId') ?? ''), String(formData.get('reason') ?? ''));

  if (!result.ok) {
    return { status: 'error', message: result.error.message };
  }

  revalidatePath('/operations');
  return { status: 'success', message: 'Cancelled. It will not be claimed, and the reason is in the audit log.' };
}
