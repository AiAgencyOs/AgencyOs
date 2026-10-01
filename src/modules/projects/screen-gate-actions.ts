'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { approveScreen, confirmScreenQa, setScreenCategory } from './screen-gate-service';

function revalidateScreens(projectId: string, screenId: string) {
  revalidatePath(`/projects/${projectId}/design/screens`);
  revalidatePath(`/projects/${projectId}/design/screens/${screenId}`);
  revalidatePath(`/projects/${projectId}/design`);
}

export async function setScreenCategoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const screenId = String(formData.get('screenId') ?? '');
  const result = await setScreenCategory({ projectId, screenId, category: String(formData.get('category') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(projectId, screenId);
  return { status: 'success', message: result.data.category ? `Category set to ${result.data.category}.` : 'Category cleared.' };
}

export async function confirmScreenQaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const screenId = String(formData.get('screenId') ?? '');
  const result = await confirmScreenQa({ projectId, screenId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(projectId, screenId);
  return { status: 'success', message: 'QA confirmation recorded.' };
}

export async function approveScreenAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const screenId = String(formData.get('screenId') ?? '');
  const result = await approveScreen({ projectId, screenId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateScreens(projectId, screenId);
  return { status: 'success', message: 'Screen approved.' };
}
