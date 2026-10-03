'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addProjectMember, removeProjectMember, setProjectMemberRole } from './project-members-service';

/** SCR-025 — the project roster's doors as Server Actions. */
function revalidateTeam(projectId: string) {
  revalidatePath(`/projects/${projectId}/team`);
  revalidatePath(`/projects/${projectId}/board`);
  revalidatePath(`/projects/${projectId}`);
}

export async function addProjectMemberAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await addProjectMember({
    projectId,
    userId: String(formData.get('userId') ?? ''),
    projectRole: (String(formData.get('projectRole') ?? '') || 'contributor') as never,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTeam(projectId);
  return { status: 'success', message: 'Added to the project.' };
}

export async function setProjectMemberRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await setProjectMemberRole({
    memberId: String(formData.get('memberId') ?? ''),
    projectRole: String(formData.get('projectRole') ?? '') as never,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTeam(projectId);
  return { status: 'success', message: 'Role changed.' };
}

export async function removeProjectMemberAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await removeProjectMember({ memberId: String(formData.get('memberId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateTeam(projectId);
  return { status: 'success', message: 'Removed from the project.' };
}
