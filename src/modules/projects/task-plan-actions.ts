'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { parseLabels } from './task-plan-schema';
import { addMyTask, addProjectNote, addSubtask, removeProjectNote, setTaskLabels } from './task-plan-service';

/** The task page's Subtasks and Labels, and the overview's Project Notes — Server Actions over the migration-20261004100000 doors. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

function revalidateTask(projectId: string, taskId: string) {
  revalidatePath(`/projects/${projectId}/development/tasks/${taskId}`);
  revalidatePath(`/projects/${projectId}/board`);
  revalidatePath(`/projects/${projectId}/tasks`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/my-tasks');
}

export async function addSubtaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const parentTaskId = str(formData, 'parentTaskId');
  const result = await addSubtask({
    projectId,
    parentTaskId,
    title: str(formData, 'title'),
    dueOn: str(formData, 'dueOn').trim() || null,
    assigneeId: str(formData, 'assigneeId').trim() || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTask(projectId, parentTaskId);
  return { status: 'success', message: 'Subtask added.' };
}

export async function setTaskLabelsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await setTaskLabels({ projectId, taskId, labels: parseLabels(str(formData, 'labels')) });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Labels saved.' };
}

export async function addProjectNoteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await addProjectNote({ projectId, title: str(formData, 'title'), body: str(formData, 'body').trim() || null });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Note added.' };
}

export async function removeProjectNoteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await removeProjectNote({ projectId, noteId: str(formData, 'noteId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Note removed.' };
}

export async function addMyTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await addMyTask({
    projectId: str(formData, 'projectId'),
    title: str(formData, 'title'),
    dueOn: str(formData, 'dueOn').trim() || null,
    status: (str(formData, 'status') || 'todo') as never,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/my-tasks');
  return { status: 'success', message: 'Task added.' };
}
