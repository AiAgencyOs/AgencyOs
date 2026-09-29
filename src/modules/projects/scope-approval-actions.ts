'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { recordScopeApproval } from './scope-approval-service';

/** SCR-030 — "Approval evidence" as a Server Action. */
export async function recordScopeApprovalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const evidenceUrl = String(formData.get('evidenceUrl') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  const result = await recordScopeApproval({
    scopeVersionId: String(formData.get('scopeVersionId') ?? ''),
    approvedBy: String(formData.get('approvedBy') ?? ''),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    ...(note ? { note } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/scope`);
  return { status: 'success', message: 'Approval recorded on the baseline.' };
}
