'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { PROTOTYPE_PLATFORMS, type PrototypePlatform } from './prototype-schema';
import { decidePrototypeAdmin, recordPrototypeQaCheck, sendPrototypeForClientReview, setDeliverableDetails } from './build-details-service';

function revalidateBuilds(projectId: string, deliverableId?: string) {
  revalidatePath(`/projects/${projectId}/prototype`);
  revalidatePath(`/projects/${projectId}/builds`);
  if (deliverableId) revalidatePath(`/projects/${projectId}/prototype/builds/${deliverableId}`);
}

export async function setDeliverableDetailsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const deliverableId = String(formData.get('deliverableId') ?? '');
  const platform = String(formData.get('platform') ?? '');
  const result = await setDeliverableDetails({
    projectId,
    deliverableId,
    platform: (PROTOTYPE_PLATFORMS as readonly string[]).includes(platform) ? (platform as PrototypePlatform) : undefined,
    commitRef: String(formData.get('commitRef') ?? ''),
    buildNumber: String(formData.get('buildNumber') ?? ''),
    rollbackTargetId: String(formData.get('rollbackTargetId') ?? '').trim() || undefined,
    rollbackNote: String(formData.get('rollbackNote') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateBuilds(projectId, deliverableId);
  return { status: 'success', message: 'Details saved.' };
}

export async function decidePrototypeAdminAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const deliverableId = String(formData.get('deliverableId') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const result = await decidePrototypeAdmin({
    projectId,
    deliverableId,
    decision: decision === 'approved' ? 'approved' : 'changes_required',
    note: String(formData.get('note') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateBuilds(projectId, deliverableId);
  return { status: 'success', message: result.data.decision === 'approved' ? 'Approved as Admin.' : 'Changes requested.' };
}

export async function sendPrototypeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const deliverableId = String(formData.get('deliverableId') ?? '');
  const result = await sendPrototypeForClientReview({ projectId, deliverableId, overrideReason: String(formData.get('overrideReason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateBuilds(projectId, deliverableId);
  revalidatePath('/design');
  revalidatePath('/approvals');
  return { status: 'success', message: result.data.overridden ? 'Sent to the client around the gate; the override is on the audit trail.' : 'Sent for client review.' };
}

export async function recordPrototypeQaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const deliverableId = String(formData.get('deliverableId') ?? '');
  const outcome = String(formData.get('outcome') ?? '');
  const result = await recordPrototypeQaCheck({
    projectId,
    deliverableId,
    outcome: outcome === 'passed' ? 'passed' : 'changes_required',
    note: String(formData.get('note') ?? ''),
    evidenceUrl: String(formData.get('evidenceUrl') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateBuilds(projectId, deliverableId);
  return { status: 'success', message: result.data.outcome === 'passed' ? 'QA check recorded as passed.' : 'QA asked for changes.' };
}
