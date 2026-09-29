'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import {
  addChecklistItem,
  addTaskAttachment,
  addTaskComment,
  removeChecklistItem,
  removeTaskAttachment,
  setChecklistItemDone,
} from './task-collab-service';

/**
 * Task collaboration — thin wrappers over task-collab-service.ts. Every
 * form carries `projectId` and `taskId` so the three surfaces that draw a
 * task (the Board drawer, the My Tasks drawer, the task page) are all
 * revalidated by every write.
 */
function revalidateTask(projectId: string, taskId: string) {
  revalidatePath(`/projects/${projectId}/board`);
  revalidatePath(`/projects/${projectId}/development`);
  revalidatePath(`/projects/${projectId}/development/tasks/${taskId}`);
  revalidatePath('/my-tasks');
}

export async function addTaskCommentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await addTaskComment({ taskId, body: String(formData.get('body') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Comment added.' };
}

export async function addChecklistItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await addChecklistItem({ taskId, label: String(formData.get('label') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Item added.' };
}

export async function setChecklistItemDoneAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await setChecklistItemDone({
    itemId: String(formData.get('itemId') ?? ''),
    done: String(formData.get('done') ?? '') === 'true',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTask(projectId, taskId);
  return { status: 'success', message: result.data.done ? 'Ticked.' : 'Unticked.' };
}

export async function removeChecklistItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await removeChecklistItem({ itemId: String(formData.get('itemId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Item removed.' };
}

export async function addTaskAttachmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await addTaskAttachment({
    taskId,
    title: String(formData.get('title') ?? ''),
    url: String(formData.get('url') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Link attached.' };
}

export async function removeTaskAttachmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const taskId = String(formData.get('taskId') ?? '');

  const result = await removeTaskAttachment({ attachmentId: String(formData.get('attachmentId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Attachment removed.' };
}
