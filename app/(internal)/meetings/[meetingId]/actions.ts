'use server';

import { revalidatePath } from 'next/cache';

import { addMeetingEvidence, cancelMeeting, completeMeeting, recordNoShow, requestMeetingAnalysis, type Concluded } from '@/lib/scheduler/meeting-commands';
import type { Result } from '@/lib/result';
import type { FormState } from '@/modules/identity/types';

/**
 * Server Actions for A09's controls — G-237. Thin, like every other form
 * action here: the capability check, the shape and the sentence live in
 * `@/lib/scheduler/meeting-commands`; the rules live in the database. Every
 * refusal is surfaced as written. The lead page is revalidated from the
 * lead_id the door returned, never from a field the form carried.
 */

const text = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
};

async function conclude(formData: FormData, command: (meetingId: string) => Promise<Result<Concluded>>): Promise<FormState> {
  const meetingId = String(formData.get('meetingId') ?? '');
  const result = await command(meetingId);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath('/meetings');
  if (result.data.leadId) revalidatePath(`/leads/${result.data.leadId}`);
  return { status: 'success', message: result.data.message };
}

export async function cancelMeetingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => cancelMeeting(id, text(formData, 'reason')));
}

export async function completeMeetingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => completeMeeting(id, String(formData.get('outcome') ?? 'completed'), text(formData, 'note')));
}

export async function recordNoShowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => recordNoShow(id, text(formData, 'note')));
}

export async function addEvidenceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) =>
    addMeetingEvidence(id, String(formData.get('kind') ?? 'notes'), String(formData.get('visibility') ?? 'internal'), String(formData.get('body') ?? '')),
  );
}

export async function requestAnalysisAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => requestMeetingAnalysis(id));
}
