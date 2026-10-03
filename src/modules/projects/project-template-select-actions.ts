'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setProjectTemplate } from './project-template-select-service';

/** SCR-027 — "Template selection" on project settings as a Server Action. */
export async function setProjectTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const templateId = String(formData.get('templateId') ?? '').trim();
  const result = await setProjectTemplate({ projectId, templateId: templateId || null });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/settings`);
  return { status: 'success', message: result.data.templateId ? 'Template recorded on the project.' : 'Template selection cleared.' };
}
