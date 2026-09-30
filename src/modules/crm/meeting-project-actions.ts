'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { linkMeetingToProject } from './meeting-project-service';

/** SCR-010 — the project link on a meeting's page. */
export async function linkMeetingProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const meetingId = String(formData.get('meetingId') ?? '');
  const projectId = String(formData.get('projectId') ?? '').trim();
  const result = await linkMeetingToProject({ meetingId, projectId: projectId === '' ? null : projectId });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath('/meetings');
  if (result.data.projectId) revalidatePath(`/projects/${result.data.projectId}`);
  return { status: 'success', message: result.data.projectId ? 'Meeting linked to the project. Audited.' : 'Project link removed. Audited.' };
}
