'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { acknowledgeEscalation, escalateBlocker, startQaHandoff } from './development-events-service';

/** SCR-039 — "Escalate blocker to PM" and "Start QA handoff", recorded. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

function revalidateDevelopment(projectId: string) {
  revalidatePath(`/projects/${projectId}/development`);
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath('/development');
}

export async function escalateBlockerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await escalateBlocker({ projectId, taskId, reason: str(formData, 'reason') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDevelopment(projectId);
  revalidatePath(`/projects/${projectId}/development/tasks/${taskId}`);
  return { status: 'success', message: 'Escalated to the PM and recorded.' };
}

export async function acknowledgeEscalationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await acknowledgeEscalation({ projectId, eventId: str(formData, 'eventId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDevelopment(projectId);
  return { status: 'success', message: 'Escalation acknowledged.' };
}

export async function startQaHandoffAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await startQaHandoff({ projectId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDevelopment(projectId);
  return { status: 'success', message: 'QA handoff started and recorded.' };
}
