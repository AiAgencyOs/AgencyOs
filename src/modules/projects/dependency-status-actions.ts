'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { DEPENDENCY_STATUSES, type DependencyStatus } from './dependency-status-schema';
import { setDependencyStatus } from './dependency-status-service';

/** SCR-043 — the Builds tab's "mark supplied / waived / reopen" control. */
export async function setDependencyStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const status = String(formData.get('status') ?? '');
  const result = await setDependencyStatus({
    projectId,
    dependencyId: String(formData.get('dependencyId') ?? ''),
    status: (DEPENDENCY_STATUSES as readonly string[]).includes(status) ? (status as DependencyStatus) : ('' as DependencyStatus),
    note: String(formData.get('note') ?? '').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}/builds`);
  revalidatePath(`/projects/${projectId}/development`);
  revalidatePath('/development');
  return {
    status: 'success',
    message: result.data.status === 'open' ? 'Dependency reopened.' : result.data.status === 'waived' ? 'Dependency waived.' : 'Dependency marked supplied.',
  };
}
