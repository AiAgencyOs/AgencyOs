'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { assignRetest } from './retest-service';

/** SCR-044 — "Assign retest", from the QA dashboard's retest queue and the project's QA page. */
export async function assignRetestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const projectId = text('projectId');
  const result = await assignRetest({
    projectId,
    defectId: text('defectId'),
    retesterId: text('retesterId'),
    ...(text('note') ? { note: text('note') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/qa');
  revalidatePath(`/projects/${projectId}/qa`);
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Retest assigned. The defect is theirs to verify.' };
}
