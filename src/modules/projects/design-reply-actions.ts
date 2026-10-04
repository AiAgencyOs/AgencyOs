'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { acceptDesignReply, dismissDesignReply } from './design-reply-service';

/** The two things a person does with a client reply the PM read but would not decide (Phase 3 PM §4.9). */

export async function acceptDesignReplyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await acceptDesignReply({
    proposalId: String(formData.get('proposalId') ?? ''),
    themeOptionId: String(formData.get('themeOptionId') ?? '') || undefined,
    colorOptionId: String(formData.get('colorOptionId') ?? '') || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/design`);
  return { status: 'success', message: 'Recorded as the client’s answer.' };
}

export async function dismissDesignReplyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await dismissDesignReply({ proposalId: String(formData.get('proposalId') ?? ''), note: String(formData.get('note') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/design`);
  return { status: 'success', message: 'Dismissed, with your reason on the record.' };
}
