'use server';

import { revalidatePath } from 'next/cache';

import { cancelRunningJob } from '@/lib/observability/cancel-running';
import type { FormState } from '@/modules/identity/types';

/** SCR-065/066 — ask one RUNNING job to stop at its next step, with a reason. Refusals are surfaced as written. */
export async function cancelRunningJobAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await cancelRunningJob(String(formData.get('jobId') ?? ''), String(formData.get('reason') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/operations');
  revalidatePath('/usage/runs');
  return { status: 'success', message: 'Asked to stop. The runner settles it as cancelled at its next step; the request is in the audit log.' };
}
