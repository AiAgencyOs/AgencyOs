'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { appendMessage, requestExtraction, startConversation } from './service';

/**
 * Server Actions for requirement collection — thin wrappers: validate → call
 * the service → shape a FormState (ARCHITECTURE.md §3.2).
 *
 * Authentication and capability checks live in the service, so they hold no
 * matter who calls it. Reusing identity's FormState keeps one form-result
 * shape across the app rather than inventing a second.
 */

export async function startConversationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await startConversation({
    leadId: String(formData.get('leadId') ?? ''),
    channel: 'manual',
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return { status: 'success', message: 'Conversation started.' };
}

export async function appendMessageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const authorType = String(formData.get('authorType') ?? 'client');

  const result = await appendMessage({
    conversationId: String(formData.get('conversationId') ?? ''),
    authorType: authorType === 'user' ? 'user' : 'client',
    body: String(formData.get('body') ?? ''),
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.error.message,
      ...(result.error.details ? { fieldErrors: result.error.details } : {}),
    };
  }

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return { status: 'success', message: 'Message added.' };
}

export async function requestExtractionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await requestExtraction({
    conversationId: String(formData.get('conversationId') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
  return {
    status: 'success',
    message: result.data.enqueued
      ? 'Extraction queued. Run the job runner to process it.'
      : 'An extraction is already queued for this transcript.',
  };
}
