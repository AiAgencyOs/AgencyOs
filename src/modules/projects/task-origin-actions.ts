'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { markTaskAgentGenerated, verifyAgentTask } from './task-origin-service';

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

function refresh(projectId: string) {
  revalidatePath(`/projects/${projectId}/board`);
  revalidatePath(`/projects/${projectId}/development`);
  revalidatePath('/my-tasks');
}

export async function markTaskAgentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const agent = str(formData, 'agent') === 'true';
  const result = await markTaskAgentGenerated({ projectId, taskId: str(formData, 'taskId'), agent });
  if (!result.ok) return { status: 'error', message: result.error.message };
  refresh(projectId);
  return { status: 'success', message: agent ? 'Marked as agent-generated. It cannot be completed until it is verified.' : 'Marked as human work.' };
}

export async function verifyAgentTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await verifyAgentTask({ projectId, taskId: str(formData, 'taskId'), note: str(formData, 'note') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  refresh(projectId);
  return { status: 'success', message: 'Verified and recorded. The task can now be completed.' };
}
