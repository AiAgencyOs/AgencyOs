'use server';

import { revalidatePath } from 'next/cache';

import { addMeetingEvidence, addMeetingEvidenceFile, cancelMeeting, completeMeeting, recordNoShow, requestMeetingAnalysis, rescheduleMeeting, type Concluded } from '@/lib/scheduler/meeting-commands';
import { bookProposedSlot, proposeSlots, type SchedulingHooks } from '@/lib/scheduling/booking';
import type { Result } from '@/lib/result';
import { uploadMeetingStoredFile } from '@/modules/crm/meeting-file-service';
import { draftConfirmation, draftNoAvailability, draftProposal } from '@/modules/crm/p1r-scheduling-compose';
import { decideMeetingNoteFile, routeMeetingFile } from '@/modules/crm/meeting-note-file';
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

/**
 * SCR-060 "Meeting note upload". A text file's text is read here, judged by the
 * pure rules (size, credentials) and filed through the same door as typed
 * evidence, keeping the human's own words verbatim. A recording, an image, a
 * PDF or a Word file (Q-D3) is stored as it is under the project-file rules and
 * filed through `crm.add_meeting_evidence_file`; the file's own words are not
 * read, so nothing here rewrites or summarises it.
 */
export async function uploadEvidenceFileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const file = formData.get('file');
  if (typeof File === 'undefined' || !(file instanceof File) || file.size === 0) {
    return { status: 'error', message: 'Choose a file to upload.' };
  }
  if (routeMeetingFile(file.name) === 'stored') {
    const meetingId = String(formData.get('meetingId') ?? '');
    const stored = await uploadMeetingStoredFile({ meetingId, visibility: String(formData.get('visibility') ?? 'internal') }, file);
    if (!stored.ok) return { status: 'error', message: stored.error.message };
    revalidatePath(`/meetings/${meetingId}`);
    revalidatePath('/meetings');
    if (stored.data.leadId) revalidatePath(`/leads/${stored.data.leadId}`);
    return { status: 'success', message: stored.data.message };
  }
  const decision = decideMeetingNoteFile({ name: file.name, type: file.type, size: file.size, text: await file.text() });
  if (!decision.ok) return { status: 'error', message: decision.message };
  return conclude(formData, (id) => addMeetingEvidenceFile(id, String(formData.get('visibility') ?? 'internal'), decision));
}

export async function requestAnalysisAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => requestMeetingAnalysis(id));
}

/**
 * Round 4: after a step stands, the words to the client are DRAFTED (a proposal, a "nothing is free" note, a confirmation) for a person to read, edit and send from
 * "Meetings that need a person". Nothing is sent from here.
 */
const DRAFT_HOOKS: SchedulingHooks = {
  proposed: (c) => draftProposal({ meetingId: c.meetingId, leadId: c.leadId, slots: c.slots, timezone: c.timezone, mode: c.mode, clientName: c.clientName }),
  nothingToOffer: (c) => draftNoAvailability({ meetingId: c.meetingId, leadId: c.leadId, clientName: c.clientName }),
  booked: (c) => draftConfirmation({ meetingId: c.meetingId, leadId: c.leadId, slot: c.slot, timezone: c.timezone, mode: c.mode, meetUrl: c.meetUrl, clientName: c.clientName }),
};

/** G-243 — §5 up to PROPOSE, by a person, from what the calendar has free. */
export async function proposeSlotsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => proposeSlots(id, Number(formData.get('duration') ?? 30), DRAFT_HOOKS));
}

/** G-243 — RECHECK → the provider event → the row, on one of the slots offered. */
export async function bookSlotAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return conclude(formData, (id) => bookProposedSlot(id, String(formData.get('startAt') ?? ''), String(formData.get('mode') ?? 'call'), DRAFT_HOOKS));
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
