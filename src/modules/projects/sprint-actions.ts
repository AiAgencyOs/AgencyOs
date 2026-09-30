'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { closeSprint, createSprint, placeTaskInSprint } from './sprint-service';

/** Sprints — Server Actions over the migration-20261005100000 doors. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

function revalidateSprints(projectId: string, taskId?: string) {
  revalidatePath(`/projects/${projectId}/board`);
  revalidatePath(`/projects/${projectId}/tasks`);
  revalidatePath(`/projects/${projectId}`);
  if (taskId) revalidatePath(`/projects/${projectId}/development/tasks/${taskId}`);
}

export async function createSprintAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await createSprint({
    projectId,
    name: str(formData, 'name'),
    startsOn: str(formData, 'startsOn'),
    lengthDays: Number(str(formData, 'lengthDays')),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateSprints(projectId);
  return { status: 'success', message: 'Sprint created.' };
}

export async function closeSprintAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await closeSprint({ projectId, sprintId: str(formData, 'sprintId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateSprints(projectId);
  return { status: 'success', message: 'Sprint closed.' };
}

export async function placeTaskInSprintAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await placeTaskInSprint({ projectId, taskId, sprintId: str(formData, 'sprintId').trim() || null });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateSprints(projectId, taskId);
  return { status: 'success', message: result.data.placed ? 'Placed in the sprint.' : 'Taken out of the sprint.' };
}
