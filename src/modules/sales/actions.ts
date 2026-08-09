'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { convertToProject, createOpportunity, setOpportunityStage } from './service';

/** Server Actions for the sales pipeline — thin wrappers over service.ts. */

function revalidateLead(formData: FormData) {
  revalidatePath(`/leads/${String(formData.get('leadId') ?? '')}`);
}

export async function createOpportunityAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const value = String(formData.get('valueMinor') ?? '').trim();

  const result = await createOpportunity({
    leadId: String(formData.get('leadId') ?? ''),
    name: String(formData.get('name') ?? ''),
    valueMinor: value ? Number(value) : 0,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: 'Deal opened.' };
}

export async function setOpportunityStageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await setOpportunityStage({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    stage: String(formData.get('stage') ?? '') as never,
    lostReason: String(formData.get('lostReason') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateLead(formData);
  return { status: 'success', message: `Deal moved to ${result.data.stage}.` };
}

export async function convertToProjectAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await convertToProject({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    projectName: String(formData.get('projectName') ?? ''),
    clientAccountName: String(formData.get('clientAccountName') ?? '') || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateLead(formData);
  revalidatePath('/projects');
  return {
    status: 'success',
    message: result.data.created
      ? 'Client and project created.'
      : 'This deal was already converted; showing the existing project.',
  };
}
