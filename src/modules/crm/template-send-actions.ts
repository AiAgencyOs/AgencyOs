'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { sendTemplateMessage } from './template-send-service';

/**
 * The composer's template send — owner decision 2026-09-29. Thin: the door
 * (`template-send-service.ts`) checks the capability, the template's
 * approval, the variables, consent and the outreach limits, and every
 * refusal is shown as written.
 */
export async function sendTemplateMessageAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const leadId = text('leadId');

  const result = await sendTemplateMessage({
    conversationId: text('conversationId'),
    templateId: text('templateId'),
    ...(text('proposalId') ? { proposalId: text('proposalId') } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  if (leadId) revalidatePath(`/leads/${leadId}`);
  return { status: 'success', message: `Template ${result.data.templateName} sent to the client.` };
}
