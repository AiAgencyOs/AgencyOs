'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { decideFollowUpSequence } from './follow-up-decision-service';
import { FOLLOW_UP_DECISIONS, type FollowUpDecision } from './follow-up-decision-schema';

/** SCR-013 — reschedule / complete / cancel from the Follow-ups list and the Lead 360's sequences card. */
export async function decideFollowUpSequenceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const action = String(formData.get('action') ?? '') as FollowUpDecision;
  if (!(FOLLOW_UP_DECISIONS as readonly string[]).includes(action)) return { status: 'error', message: 'Not a decision this door takes.' };
  const rawWhen = String(formData.get('nextDueAt') ?? '').trim();
  // A datetime-local input gives "YYYY-MM-DDTHH:mm" in the browser's zone;
  // an ISO instant is what the column holds.
  const nextDueAt = rawWhen ? new Date(rawWhen).toISOString() : undefined;
  if (action === 'reschedule' && (!nextDueAt || Number.isNaN(Date.parse(rawWhen)))) return { status: 'error', message: 'A reschedule needs the new time.' };

  const result = await decideFollowUpSequence({
    sequenceId: String(formData.get('sequenceId') ?? ''),
    action,
    reason: String(formData.get('reason') ?? ''),
    ...(action === 'reschedule' ? { nextDueAt } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/follow-ups');
  const leadId = String(formData.get('leadId') ?? '');
  if (leadId) revalidatePath(`/leads/${leadId}`);
  return {
    status: 'success',
    message: action === 'reschedule' ? 'Rescheduled; the sequence is active again. Audited.' : action === 'complete' ? 'Marked complete. Audited.' : 'Cancelled. Audited.',
  };
}
