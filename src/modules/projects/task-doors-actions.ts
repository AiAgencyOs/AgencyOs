'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { EVIDENCE_KINDS, type EvidenceKind } from './task-doors-schema';
import { markTaskReadyForQa, reopenTaskFromDefect, startTask, submitTaskEvidence } from './task-doors-service';

/** SCR-041 — the task page's start / ready for QA / submit evidence / reopen controls. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

function revalidateTask(projectId: string, taskId: string) {
  revalidatePath(`/projects/${projectId}/development/tasks/${taskId}`);
  revalidatePath(`/projects/${projectId}/development`);
  revalidatePath(`/projects/${projectId}/board`);
  revalidatePath('/my-tasks');
  revalidatePath('/development');
}

export async function startTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await startTask({ projectId, taskId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Task started.' };
}

export async function markTaskReadyForQaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await markTaskReadyForQa({ projectId, taskId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTask(projectId, taskId);
  return { status: 'success', message: `Ready for QA with ${result.data.evidenceCount} piece${result.data.evidenceCount === 1 ? '' : 's'} of evidence.` };
}

export async function submitTaskEvidenceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const kind = str(formData, 'kind');
  const result = await submitTaskEvidence({
    projectId,
    taskId,
    kind: (EVIDENCE_KINDS as readonly string[]).includes(kind) ? (kind as EvidenceKind) : ('' as EvidenceKind),
    title: str(formData, 'title'),
    url: str(formData, 'url').trim() || undefined,
    note: str(formData, 'note').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Evidence submitted.' };
}

export async function reopenTaskFromDefectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await reopenTaskFromDefect({ projectId, taskId, defectId: str(formData, 'defectId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTask(projectId, taskId);
  return { status: 'success', message: 'Task reopened from the defect.' };
}
