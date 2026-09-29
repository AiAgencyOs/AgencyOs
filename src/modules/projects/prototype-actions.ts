'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { PROTOTYPE_PLATFORMS, type PrototypePlatform } from './prototype-schema';
import { setPrototypePlatform, submitPrototypeToQa } from './prototype-service';

/** SCR-037 — the Prototype tab's platform picker and "submit to QA" button. */

export async function setPrototypePlatformAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const platform = String(formData.get('platform') ?? '');
  const result = await setPrototypePlatform({
    projectId,
    artifactId: String(formData.get('artifactId') ?? ''),
    platform: (PROTOTYPE_PLATFORMS as readonly string[]).includes(platform) ? (platform as PrototypePlatform) : ('' as PrototypePlatform),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/prototype`);
  return { status: 'success', message: `Platform set to ${result.data.platform.replace('_', ' ')}.` };
}

export async function submitPrototypeToQaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await submitPrototypeToQa({ projectId, artifactId: String(formData.get('artifactId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/prototype`);
  revalidatePath(`/projects/${projectId}/qa`);
  return { status: 'success', message: 'Prototype submitted to QA.' };
}
