'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { replayRun } from './replay-service';

/** SCR-065 — the run page's "Replay" for read-only work. Refusals are shown as written. */
export async function replayRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const runId = String(formData.get('runId') ?? '');
  const result = await replayRun({ runId, reason: String(formData.get('reason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/usage/runs/${runId}`);
  revalidatePath('/operations');
  return { status: 'success', message: `Queued again as job ${result.data.jobId.slice(0, 8)} — the next tick runs it. Audited.` };
}
