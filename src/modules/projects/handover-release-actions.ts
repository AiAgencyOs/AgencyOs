'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { recordReleaseVerification, setHandoverRollbackPlan, setHandoverSmokeItem } from './handover-release-service';

/** SCR-049 — the Release tab's two writes. */

function revalidateRelease(formData: FormData) {
  const projectId = String(formData.get('projectId') ?? '');
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath(`/projects/${projectId}`);
}

export async function setRollbackPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setHandoverRollbackPlan({
    projectId: String(formData.get('projectId') ?? ''),
    rollbackPlan: String(formData.get('rollbackPlan') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateRelease(formData);
  return { status: 'success', message: result.data.cleared ? 'Rollback plan cleared.' : 'Rollback plan recorded.' };
}

export async function setSmokeItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setHandoverSmokeItem({
    projectId: String(formData.get('projectId') ?? ''),
    label: String(formData.get('label') ?? ''),
    done: formData.get('done') === 'true',
    remove: formData.get('remove') === 'true',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateRelease(formData);
  return { status: 'success', message: result.data.removed ? 'Check removed.' : 'Checklist updated.' };
}

/** SCR-049 — "Record post-deploy verification". */
export async function recordVerificationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const result = await recordReleaseVerification({
    projectId: text('projectId'),
    environment: text('environment') as never,
    outcome: text('outcome') as never,
    ...(text('deliverableId') ? { deliverableId: text('deliverableId') } : {}),
    ...(text('notes') ? { notes: text('notes') } : {}),
    ...(text('evidenceUrl') ? { evidenceUrl: text('evidenceUrl') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateRelease(formData);
  return { status: 'success', message: 'Verification recorded.' };
}
