'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { attachMeetingSummaryToMemory } from './meeting-memory-service';

/**
 * SCR-017 — "Attach to project memory", on the meeting page and on Client
 * 360 › Communication's meeting notes. The client path to revalidate comes
 * from the form; the lead path from the door.
 */
export async function attachMeetingSummaryToMemoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const meetingId = String(formData.get('meetingId') ?? '');
  const projectId = String(formData.get('projectId') ?? '');
  const clientId = String(formData.get('clientId') ?? '');

  const result = await attachMeetingSummaryToMemory({ meetingId, projectId });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath(`/projects/${projectId}`);
  if (clientId) revalidatePath(`/clients/${clientId}`);
  if (result.data.leadId) revalidatePath(`/leads/${result.data.leadId}`);

  return {
    status: 'success',
    message: result.data.alreadyThere
      ? 'This summary is already in the project’s memory; nothing was written twice.'
      : 'Attached to the project’s memory, with the meeting evidence as its source.',
  };
}
