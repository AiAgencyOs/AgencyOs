'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { unfreezeScopeVersion } from './scope-unfreeze-service';

/** SCR-030 — the Scope tab's owner-only unfreeze. */
export async function unfreezeScopeVersionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await unfreezeScopeVersion({
    projectId,
    scopeVersionId: String(formData.get('scopeVersionId') ?? ''),
    reason: String(formData.get('reason') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/projects/${projectId}/scope`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/qa`);
  return { status: 'success', message: 'Baseline unfrozen — it is a draft again. Freeze it once it is corrected.' };
}
