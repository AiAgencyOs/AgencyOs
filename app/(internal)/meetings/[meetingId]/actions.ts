'use server';

import { revalidatePath } from 'next/cache';

import { addMeetingEvidence, cancelMeeting, completeMeeting, recordNoShow, requestMeetingAnalysis, rescheduleMeeting, type Concluded } from '@/lib/scheduler/meeting-commands';
import { bookProposedSlot, proposeSlots } from '@/lib/scheduling/booking';
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

/** G-243 — §5 up to PROPOSE, by a person, from what the calendar has free. */
export async function proposeSlotsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => proposeSlots(id, Number(formData.get('duration') ?? 30)));
}

/** G-243 — RECHECK → the provider event → the row, on one of the slots offered. */
export async function bookSlotAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => bookProposedSlot(id, String(formData.get('startAt') ?? ''), String(formData.get('mode') ?? 'call')));
}

/** G-244 — §8: the booking cancelled with its history kept, a new request minted in its place. */
export async function rescheduleMeetingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const meetingId = String(formData.get('meetingId') ?? '');
  const result = await rescheduleMeeting(meetingId, text(formData, 'reason'), {
    ...(text(formData, 'mode') ? { requestedMode: text(formData, 'mode') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath('/meetings');
  if (result.data.newMeetingId) revalidatePath(`/meetings/${result.data.newMeetingId}`);
  if (result.data.leadId) revalidatePath(`/leads/${result.data.leadId}`);
  return { status: 'success', message: result.data.message };
}
