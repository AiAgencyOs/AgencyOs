'use server';

import { revalidatePath } from 'next/cache';

import { cancelWorkflow } from '@/lib/observability/cancel-workflow';
import type { FormState } from '@/modules/identity/types';

/** SCR-066 — cancel every job of one workflow (correlation id) with one reason. Each stop is its own audited row. */
export async function cancelWorkflowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await cancelWorkflow(String(formData.get('correlationId') ?? ''), String(formData.get('reason') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/operations');
  revalidatePath('/usage/runs');
  return { status: 'success', message: result.data.summary };
}
