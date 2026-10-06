'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { BUILD_CONFIG_KEYS } from './build-depth-schema';
import { cancelBuildRequest, createClientBuildPackage, setBuildConfig } from './build-depth-service';

export async function setBuildConfigAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const config: Record<string, string> = {};
  for (const key of BUILD_CONFIG_KEYS) config[key] = String(formData.get(key) ?? '');
  const result = await setBuildConfig({ projectId, config, envNames: String(formData.get('envNames') ?? ''), note: String(formData.get('note') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: `Build configuration saved as version ${result.data.version}. Builds recorded under an older version are stale until they are built again.` };
}

export async function createClientBuildPackageAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await createClientBuildPackage({
    projectId,
    deliverableId: String(formData.get('deliverableId') ?? ''),
    limitations: String(formData.get('limitations') ?? ''),
    testingInstructions: String(formData.get('testingInstructions') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Package written. The client sees it once the build is shared.' };
}

export async function cancelBuildRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await cancelBuildRequest({ projectId, requestId: String(formData.get('requestId') ?? ''), reason: String(formData.get('reason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Build request cancelled.' };
}
