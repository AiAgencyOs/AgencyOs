'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addDefectEvidence, linkDefectBuild } from './defect-detail-service';

/**
 * SCR-047 — the bug page's two new doors. Triage and settle stay in
 * `actions.ts`; the page mounts those forms through the same components the
 * QA tab uses.
 */

function revalidateBug(formData: FormData) {
  const projectId = String(formData.get('projectId') ?? '');
  const defectId = String(formData.get('defectId') ?? '');
  revalidatePath(`/projects/${projectId}/qa/bugs/${defectId}`);
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath('/qa');
}

export async function addDefectEvidenceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await addDefectEvidence({
    defectId: String(formData.get('defectId') ?? ''),
    kind: String(formData.get('kind') ?? '') as 'url' | 'note',
    value: String(formData.get('value') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateBug(formData);
  return { status: 'success', message: 'Evidence attached.' };
}

export async function linkDefectBuildAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await linkDefectBuild({
    defectId: String(formData.get('defectId') ?? ''),
    buildId: String(formData.get('buildId') ?? '').trim() || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateBug(formData);
  revalidatePath(`/projects/${String(formData.get('projectId') ?? '')}/builds`);
  return { status: 'success', message: result.data.linked ? 'Build linked.' : 'Build unlinked.' };
}
