'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addTaskDependency, removeTaskDependency } from './task-dependency-service';

/** R2-1 — the task page's Dependencies card. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

function revalidateTask(projectId: string, taskId: string) {
  revalidatePath(`/projects/${projectId}/development/tasks/${taskId}`);
  revalidatePath(`/projects/${projectId}/board`);
  revalidatePath(`/projects/${projectId}/tasks`);
}

export async function addTaskDependencyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await addTaskDependency({ projectId, taskId, dependsOnTaskId: str(formData, 'dependsOnTaskId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Dependency added.' };
}

export async function removeTaskDependencyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await removeTaskDependency({ projectId, taskId, dependsOnTaskId: str(formData, 'dependsOnTaskId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Dependency removed.' };
}
