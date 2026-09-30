'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { linkRequirementFile, setRequirementPlan, unlinkRequirementFile } from './requirement-plan-service';

/** A requirement's priority, assignee and attached files — Server Actions over the migration-20261005100300 doors. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');
const refresh = (projectId: string) => revalidatePath(`/projects/${projectId}/requirements`);

export async function setRequirementPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const priority = str(formData, 'priority').trim();
  const result = await setRequirementPlan({
    projectId,
    scopeItemId: str(formData, 'scopeItemId'),
    priority: priority === '' ? null : (priority as never),
    assigneeId: str(formData, 'assigneeId').trim() || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  refresh(projectId);
  return { status: 'success', message: 'Saved.' };
}

export async function linkRequirementFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await linkRequirementFile({ projectId, scopeItemId: str(formData, 'scopeItemId'), fileId: str(formData, 'fileId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  refresh(projectId);
  return { status: 'success', message: 'File attached.' };
}

export async function unlinkRequirementFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await unlinkRequirementFile({ projectId, scopeItemId: str(formData, 'scopeItemId'), fileId: str(formData, 'fileId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  refresh(projectId);
  return { status: 'success', message: 'File detached.' };
}
