'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { sendProjectUpdate } from './project-updates-service';

/** SCR-019 — "Send project update" as a Server Action. The chokepoint's refusal is the message. */
export async function sendProjectUpdateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await sendProjectUpdate({
    projectId,
    body: String(formData.get('body') ?? ''),
    sentTo: (String(formData.get('sentTo') ?? '') || 'internal') as never,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/activity`);
  return {
    status: 'success',
    message: result.data.delivered ? 'Update sent to the client thread and recorded.' : 'Update recorded for the team. Nothing was sent to the client.',
  };
}
