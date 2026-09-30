'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { archiveProject } from './project-archive-service';

/** SCR-018 — "Archive completed project" as a Server Action. */
export async function archiveProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const result = await archiveProject({ projectId, ...(reason ? { reason } : {}) });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/projects');
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: result.data.alreadyArchived ? 'This project was already archived.' : 'Project archived. Find it under “Archived”.' };
}
