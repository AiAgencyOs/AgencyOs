'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { normaliseChips } from './project-classification-schema';
import { setProjectClassification } from './project-classification-service';

/** The project's type, technology and tags — a Server Action over projects.set_project_classification. */
export async function setProjectClassificationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const type = String(formData.get('type') ?? '').trim();
  const result = await setProjectClassification({
    projectId,
    type: type === '' ? null : (type as never),
    technology: normaliseChips(String(formData.get('technology') ?? '')),
    tags: normaliseChips(String(formData.get('tags') ?? '')),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/settings`);
  revalidatePath('/projects');
  return { status: 'success', message: 'Saved.' };
}
