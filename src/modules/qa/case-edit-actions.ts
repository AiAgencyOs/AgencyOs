'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { restoreTestCoverage, updateTestCase, waiveTestCoverage } from './case-edit-service';

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

function revalidateQa(formData: FormData) {
  const projectId = text(formData, 'projectId');
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath(`/projects/${projectId}/release`);
  revalidatePath('/qa');
}

/** SCR-045 — "create / update / delete": the update. */
export async function updateTestCaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await updateTestCase({
    itemId: text(formData, 'itemId'),
    reason: text(formData, 'reason'),
    criticalPath: formData.get('criticalPath') === 'on',
    ...(text(formData, 'preconditions') ? { preconditions: text(formData, 'preconditions') } : {}),
    ...(text(formData, 'steps') ? { steps: text(formData, 'steps') } : {}),
    ...(text(formData, 'expectedResult') ? { expectedResult: text(formData, 'expectedResult') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateQa(formData);
  return { status: 'success', message: 'Case saved.' };
}

export async function waiveCoverageAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await waiveTestCoverage({ planId: text(formData, 'planId'), scopeItemId: text(formData, 'scopeItemId'), reason: text(formData, 'reason') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateQa(formData);
  return { status: 'success', message: 'Rationale recorded.' };
}

export async function restoreCoverageAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await restoreTestCoverage({ planId: text(formData, 'planId'), scopeItemId: text(formData, 'scopeItemId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateQa(formData);
  return { status: 'success', message: 'Rationale withdrawn — the requirement is uncovered again.' };
}
