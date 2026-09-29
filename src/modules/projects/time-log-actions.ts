'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addTimeLog, deleteTimeLog, updateTimeLog } from './time-log-service';

/**
 * Time logs — thin wrappers over time-log-service.ts. Every form carries
 * `projectId` and `taskId` so the drawer, the task page and the project
 * report all show the same totals after a write.
 */
function revalidateTime(projectId: string, taskId: string) {
  revalidatePath(`/projects/${projectId}/board`);
  revalidatePath(`/projects/${projectId}/development/tasks/${taskId}`);
  revalidatePath(`/projects/${projectId}/reports`);
  revalidatePath('/my-tasks');
}

export async function addTimeLogAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await addTimeLog({
    projectId,
    taskId,
    hours: String(formData.get('hours') ?? ''),
    loggedOn: String(formData.get('loggedOn') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTime(projectId, taskId);
  return { status: 'success', message: 'Time logged.' };
}

export async function updateTimeLogAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await updateTimeLog({
    timeLogId: String(formData.get('timeLogId') ?? ''),
    hours: String(formData.get('hours') ?? ''),
    loggedOn: String(formData.get('loggedOn') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTime(projectId, taskId);
  return { status: 'success', message: 'Entry saved.' };
}

export async function deleteTimeLogAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await deleteTimeLog({ timeLogId: String(formData.get('timeLogId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTime(projectId, taskId);
  return { status: 'success', message: 'Entry deleted.' };
}
