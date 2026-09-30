'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { DEVICE_TARGETS, type DeviceTarget } from './screen-states-schema';
import { setScreenStates } from './screen-states-service';

/** SCR-035 — the screen page's "states, role, devices, components, coverage" form. */

const flag = (formData: FormData, key: string) => formData.get(key) === 'on' || formData.get(key) === 'true';
const targets = (formData: FormData, key: string): DeviceTarget[] =>
  formData
    .getAll(key)
    .map(String)
    .filter((v): v is DeviceTarget => (DEVICE_TARGETS as readonly string[]).includes(v));

export async function setScreenStatesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const screenId = String(formData.get('screenId') ?? '');
  const result = await setScreenStates({
    projectId,
    screenId,
    hasEmptyState: flag(formData, 'hasEmptyState'),
    hasLoadingState: flag(formData, 'hasLoadingState'),
    hasErrorState: flag(formData, 'hasErrorState'),
    hasSuccessState: flag(formData, 'hasSuccessState'),
    userRole: String(formData.get('userRole') ?? '').trim() || undefined,
    deviceTargets: targets(formData, 'deviceTargets'),
    components: String(formData.get('components') ?? ''),
    responsiveCovered: targets(formData, 'responsiveCovered'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/design/screens`);
  revalidatePath(`/projects/${projectId}/design/screens/${screenId}`);
  revalidatePath(`/projects/${projectId}/design`);
  return { status: 'success', message: 'Screen saved.' };
}
