'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  addLeadNote,
  appendMessage,
  requestExtraction,
  setLeadFollowUp,
  setLeadQualification,
  setLeadStatus,
  startConversation,
} from './service';

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

// ── Lead pipeline ─────────────────────────────────────────────────────────

function revalidateLead(formData: FormData) {
  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
}

export async function setLeadStatusAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await setLeadStatus({
    leadId: String(formData.get('leadId') ?? ''),
    status: String(formData.get('status') ?? '') as never,
    reason: String(formData.get('reason') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: `Lead moved to ${result.data.status}.` };
}

export async function addLeadNoteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await addLeadNote({
    leadId: String(formData.get('leadId') ?? ''),
    body: String(formData.get('body') ?? ''),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Note added.' };
}

export async function setLeadQualificationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const budget = String(formData.get('budgetMinor') ?? '').trim();
  const decisionMaker = String(formData.get('isDecisionMaker') ?? '');

  const result = await setLeadQualification({
    leadId: String(formData.get('leadId') ?? ''),
    qualification: {
      ...(budget ? { budgetMinor: Number(budget) } : {}),
      ...(String(formData.get('timelineNote') ?? '').trim()
        ? { timelineNote: String(formData.get('timelineNote')) }
        : {}),
      ...(decisionMaker === 'yes' || decisionMaker === 'no'
        ? { isDecisionMaker: decisionMaker === 'yes' }
        : {}),
      ...(String(formData.get('notes') ?? '').trim()
        ? { notes: String(formData.get('notes')) }
        : {}),
    },
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Qualification saved.' };
}

export async function setLeadFollowUpAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = String(formData.get('nextFollowUpAt') ?? '').trim();

  const result = await setLeadFollowUp({
    leadId: String(formData.get('leadId') ?? ''),
    // A date input gives YYYY-MM-DD; the column is timestamptz.
    nextFollowUpAt: raw ? new Date(`${raw}T09:00:00Z`).toISOString() : null,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: raw ? 'Follow-up scheduled.' : 'Follow-up cleared.' };
}
