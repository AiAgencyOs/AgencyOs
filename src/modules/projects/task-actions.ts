'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { updateTask } from './task-service';

/**
 * SCR-021 — the task drawer's edit and reassign, as one action. Every field
 * is read only when the form sent it, so a form that carries just
 * `assigneeId` changes just the assignee; an empty assignee or due date
 * means "clear", which is what a person picking "Unassigned" intends.
 *
 * Revalidates the pages that render the task: My Tasks, the project's
 * board, development and calendar views.
 */
export async function updateTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const has = (name: string) => formData.has(name);
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await updateTask({
    taskId: String(formData.get('taskId') ?? ''),
    ...(has('title') ? { title: text('title') } : {}),
    ...(has('description') ? { description: text('description') || null } : {}),
    ...(has('priority') ? { priority: text('priority') as never } : {}),
    ...(has('assigneeId') ? { assigneeId: text('assigneeId') || null } : {}),
    ...(has('dueOn') ? { dueOn: text('dueOn') || null } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/my-tasks');
  if (projectId) {
    revalidatePath(`/projects/${projectId}/board`);
    revalidatePath(`/projects/${projectId}/development`);
    revalidatePath(`/projects/${projectId}/calendar`);
  }
  return { status: 'success', message: 'Task updated.' };
}
