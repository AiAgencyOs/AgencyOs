'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { completePhase } from './phase-completion-service';

/** Project overview — complete Phase 5 or Phase 6 once the data says it is done. */
export async function completePhaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const phase = Number(formData.get('phase'));
  if (phase !== 5 && phase !== 6) return { status: 'error', message: 'Only Phase 5 and Phase 6 are completed this way.' };

  const result = await completePhase({ projectId, phase });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}`);
  return {
    status: 'success',
    message: result.data.outcome === 'already_completed' ? 'Already complete.' : phase === 5 ? 'Phase 5 complete. The M3 invoice and the Task 3 message are being raised.' : 'Phase 6 complete. The M4 invoice and the Task 4 message are being raised.',
  };
}
