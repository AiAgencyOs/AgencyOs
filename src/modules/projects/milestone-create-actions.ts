'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addUnpricedMilestone } from './milestone-create-service';

/** SCR-022 — "create a milestone on this day" as a Server Action. */
export async function addUnpricedMilestoneAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const dueOn = String(formData.get('dueOn') ?? '').trim();
  const result = await addUnpricedMilestone({ projectId, name: String(formData.get('name') ?? ''), ...(dueOn ? { dueOn } : {}) });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/calendar`);
  revalidatePath(`/projects/${projectId}/plan`);
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Milestone added. It carries no payment share — price it on the Plan tab if it should.' };
}
