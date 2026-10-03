'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { commentOnRequirement } from './requirement-comments-service';

/** The Requirements tab's "Add Comment" door as a Server Action. */
export async function commentOnRequirementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await commentOnRequirement({
    scopeItemId: String(formData.get('scopeItemId') ?? ''),
    body: String(formData.get('body') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/requirements`);
  return { status: 'success', message: 'Comment added.' };
}
