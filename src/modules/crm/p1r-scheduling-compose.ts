import 'server-only';

import { createClient } from '@/lib/db/server';
import {
  composeConfirmation, composeNoAvailability, composeProposal,
  type DraftLanguage, type MeetingMode, type TimeSlot,
} from '@/lib/scheduling/p1r-messages';
import { quotationLanguageForLead } from '@/modules/sales/quotation-language';

import { saveSchedulingDraft } from './p1r-scheduling-drafts';

/**
 * Round 4, Scheduler: the moments a client-facing message is DRAFTED (never sent). Called by the propose and book steps AFTER they succeeded; a draft that cannot
 * be written or kept is logged and never undoes, delays or fails the step it describes.
 */
const MODES = new Set(['call', 'video_meeting', 'in_person_meeting', 'other']);
const asMode = (v: string | null | undefined): MeetingMode => (v && MODES.has(v) ? (v as MeetingMode) : 'other');

async function languageFor(leadId: string | null): Promise<DraftLanguage> {
  try {
    return (await quotationLanguageForLead(await createClient(), leadId)) as DraftLanguage;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'p1r-scheduling-compose.language', detail: e instanceof Error ? e.message : 'unknown' }));
    return 'en';
  }
}

async function keep(meetingId: string, kind: 'proposal' | 'confirmation' | 'no_availability', language: DraftLanguage, compose: () => string): Promise<void> {
  try {
    const saved = await saveSchedulingDraft({ meetingId, kind, language, body: compose() });
    if (!saved.ok) console.error(JSON.stringify({ level: 'warn', scope: 'p1r-scheduling-compose', meetingId, kind, detail: saved.error.message }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'p1r-scheduling-compose', meetingId, kind, detail: e instanceof Error ? e.message : 'unknown' }));
  }
}

export async function draftProposal(input: { meetingId: string; leadId: string | null; slots: readonly TimeSlot[]; timezone: string; mode: string | null; clientName?: string | null }): Promise<void> {
  if (input.slots.length === 0) return;
  const language = await languageFor(input.leadId);
  await keep(input.meetingId, 'proposal', language, () => composeProposal({ slots: input.slots, timezone: input.timezone, mode: asMode(input.mode), language, clientName: input.clientName }));
}

export async function draftNoAvailability(input: { meetingId: string; leadId: string | null; clientName?: string | null }): Promise<void> {
  const language = await languageFor(input.leadId);
  await keep(input.meetingId, 'no_availability', language, () => composeNoAvailability({ language, clientName: input.clientName }));
}

export async function draftConfirmation(input: { meetingId: string; leadId: string | null; slot: TimeSlot; timezone: string; mode: string | null; meetUrl: string | null; clientName?: string | null }): Promise<void> {
  const language = await languageFor(input.leadId);
  await keep(input.meetingId, 'confirmation', language, () =>
    composeConfirmation({ startAt: input.slot.startAt, endAt: input.slot.endAt, timezone: input.timezone, mode: asMode(input.mode), meetUrl: input.meetUrl, language, clientName: input.clientName }));
}
