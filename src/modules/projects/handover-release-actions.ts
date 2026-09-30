'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setHandoverRollbackPlan, setHandoverSmokeItem } from './handover-release-service';

/** SCR-049 — the Release tab's two writes. */

function revalidateRelease(formData: FormData) {
  const projectId = String(formData.get('projectId') ?? '');
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath(`/projects/${projectId}`);
}

export async function setRollbackPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setHandoverRollbackPlan({
    handoverId: String(formData.get('handoverId') ?? ''),
    rollbackPlan: String(formData.get('rollbackPlan') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateRelease(formData);
  return { status: 'success', message: result.data.cleared ? 'Rollback plan cleared.' : 'Rollback plan recorded.' };
}

export async function setSmokeItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setHandoverSmokeItem({
    handoverId: String(formData.get('handoverId') ?? ''),
    label: String(formData.get('label') ?? ''),
    done: formData.get('done') === 'true',
    remove: formData.get('remove') === 'true',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateRelease(formData);
  return { status: 'success', message: result.data.removed ? 'Check removed.' : 'Checklist updated.' };
}
