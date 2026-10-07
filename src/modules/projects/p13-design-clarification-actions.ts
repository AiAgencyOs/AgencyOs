'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { answerClarification, markClarificationAsked } from './p13-design-clarifications';

export async function markClarificationAskedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await markClarificationAsked({
    id: String(formData.get('id') ?? ''),
    via: String(formData.get('via') ?? ''),
    evidence: String(formData.get('evidence') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${String(formData.get('projectId') ?? '')}/design-clarifications`);
  return { status: 'success', message: 'Recorded that the client was asked. Nothing was sent from here.' };
}

export async function answerClarificationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await answerClarification({
    id: String(formData.get('id') ?? ''),
    answer: String(formData.get('answer') ?? ''),
    fieldsText: String(formData.get('fields') ?? ''),
    evidence: String(formData.get('evidence') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${String(formData.get('projectId') ?? '')}/design-clarifications`);
  return { status: 'success', message: 'The answer is recorded and returned to design.' };
}
