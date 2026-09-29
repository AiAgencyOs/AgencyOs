'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { sendRequirementQuestion } from './requirement-question-service';

/**
 * SCR-029 — the "Request clarification" button beside one open question on
 * the Lead 360 requirement panel. The refusal is shown as the door said it.
 */
export async function sendRequirementQuestionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '');

  const result = await sendRequirementQuestion({
    versionId: text('versionId'),
    questionIndex: Number(text('questionIndex')),
    question: text('question'),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  const leadId = text('leadId');
  if (leadId) revalidatePath(`/leads/${leadId}`);
  return { status: 'success', message: 'Sent to the client. Their answer arrives on the thread; nothing here reads it for you.' };
}
