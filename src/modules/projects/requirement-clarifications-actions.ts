'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { answerRequirementClarification, raiseRequirementClarification } from './requirement-clarifications-service';

/** The Requirements tab's "Request clarification" and "Record the answer" doors as Server Actions. */
export async function raiseRequirementClarificationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await raiseRequirementClarification({
    scopeItemId: String(formData.get('scopeItemId') ?? ''),
    question: String(formData.get('question') ?? ''),
    impact: String(formData.get('impact') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/requirements`);
  revalidatePath('/requirements');
  return { status: 'success', message: 'Clarification requested on this requirement.' };
}

export async function answerRequirementClarificationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await answerRequirementClarification({
    clarificationId: String(formData.get('clarificationId') ?? ''),
    answer: String(formData.get('answer') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/requirements`);
  revalidatePath('/requirements');
  return { status: 'success', message: 'Answer recorded.' };
}
