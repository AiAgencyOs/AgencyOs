'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { activatePolicyVersion, discardPolicyDraft, savePolicyDraft } from './p13-policy-service';

export async function savePolicyDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await savePolicyDraft({
    kind: String(formData.get('kind') ?? ''),
    bodyText: String(formData.get('body') ?? ''),
    summary: String(formData.get('summary') ?? ''),
    effectiveFrom: String(formData.get('effectiveFrom') ?? '') || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/policy-versions');
  return { status: 'success', message: `Draft version ${result.data.version} saved. It changes nothing until it is activated.` };
}

export async function activatePolicyVersionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await activatePolicyVersion({ id: String(formData.get('id') ?? ''), reason: String(formData.get('reason') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/policy-versions');
  return { status: 'success', message: 'Activated and audited. The previous version stays in the history.' };
}

export async function discardPolicyDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await discardPolicyDraft(String(formData.get('id') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/policy-versions');
  return { status: 'success', message: 'Draft discarded.' };
}
