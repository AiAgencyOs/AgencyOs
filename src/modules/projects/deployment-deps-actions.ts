'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setDeploymentDependency } from './deployment-deps-service';

/** SCR-049 — the Release tab's deployment dependencies. */
export async function setDeploymentDependencyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const projectId = text('projectId');
  const result = await setDeploymentDependency({
    projectId,
    handoverId: text('handoverId'),
    label: text('label'),
    status: text('status') === 'ready' ? 'ready' : 'pending',
    remove: text('remove') === 'true',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath('/production-readiness');
  return { status: 'success', message: result.data.removed ? 'Dependency removed.' : 'Dependencies updated.' };
}
