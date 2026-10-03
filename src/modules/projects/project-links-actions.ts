'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addProjectLink, removeProjectLink } from './project-links-service';

/** SCR-019 — the links panel's doors as Server Actions. */
export async function addProjectLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await addProjectLink({
    projectId,
    label: String(formData.get('label') ?? ''),
    url: String(formData.get('url') ?? ''),
    kind: (String(formData.get('kind') ?? '') || 'other') as never,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Link added.' };
}

export async function removeProjectLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await removeProjectLink({ linkId: String(formData.get('linkId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Link removed.' };
}
