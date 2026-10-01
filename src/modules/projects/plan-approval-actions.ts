'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { approveProjectPlan } from './plan-approval-service';

export async function approveProjectPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await approveProjectPlan({ planId: String(formData.get('planId') ?? ''), note: String(formData.get('note') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/plan`);
  revalidatePath(`/projects/${projectId}/development`);
  return { status: 'success', message: 'Plan approved internally. It can now be activated.' };
}
