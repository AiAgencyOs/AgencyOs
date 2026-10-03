'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { holdRelease, liftReleaseHold } from './release-hold-service';

/** SCR-044 — the Release tab's hold and lift. */

function revalidateRelease(projectId: string) {
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/qa');
  revalidatePath('/production-readiness');
}

export async function holdReleaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await holdRelease({ projectId, reason: String(formData.get('reason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateRelease(projectId);
  return { status: 'success', message: 'Release held. Production sign-off is refused until the hold is lifted.' };
}

export async function liftReleaseHoldAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await liftReleaseHold({ projectId, reason: String(formData.get('reason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateRelease(projectId);
  return { status: 'success', message: 'Release hold lifted.' };
}
