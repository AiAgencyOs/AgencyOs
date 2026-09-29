'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { markMilestoneMet } from './milestone-service';

/** SCR-023 — the plan page's "mark milestone met" button. */
export async function markMilestoneMetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');

  const result = await markMilestoneMet({ milestoneId: String(formData.get('milestoneId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}/plan`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/calendar`);
  revalidatePath(`/projects/${projectId}/activity`);
  return { status: 'success', message: 'Milestone marked met.' };
}
