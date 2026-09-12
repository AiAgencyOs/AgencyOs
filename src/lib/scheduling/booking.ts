import 'server-only';

import { z } from 'zod';

import { getAgencyTimeZone } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { Json } from '@/lib/db/types';
import { err, ok, type Result } from '@/lib/result';
import { interpretBook, interpretPropose } from '@/lib/scheduler/meeting-commands-eval';

import { bufferedSlot, offerableSlots, proposalWindow, readAvailabilityFrom, sliceWindows, slotStillFree, type Slot } from './availability';
import { createGoogleCalendar } from './google';

/**
 * Proposing and booking a slot from the meeting page — G-243, §5 and §6.
 *
 * Person-driven, deliberately: the Sales agent that would offer times in a
 * chat is not activated (ADM-82), so a person clicks *Propose a time*, tells
 * the client the options themselves, and clicks *Book* on the one chosen.
 * Every step is the specification's pipeline with a person where the agent
 * would be — REQUEST → CALENDAR QUERY → FILTER → RANK → PROPOSE, then
 * RECHECK → provider event → the row's own door.
 *
 * What is written is what the calendar answered. The adapter is asked
 * through the port; the offer goes through `crm.propose_meeting_slots`,
 * which refuses an offer with no read behind it; the re-check is recorded
 * through `crm.note_availability_read` so `crm.book_meeting`'s freshness
 * bound measures the re-check; the Google event is created BEFORE the row
 * is booked and cancelled again if the row refuses — a booked row whose
 * calendar has no event is the false success §14 forbids, and so is an
 * event whose row was never booked.
 */

const meetingId = z.string().uuid();
const DEFAULT_DURATIONS = [30, 45, 60] as const;
/** §5.1's local rules for an agency with no policy rows yet: an hour's notice, a quarter-hour either side. */
const CONSTRAINTS = { minimumNoticeMinutes: 60, bufferMinutes: 15 };
/** How far ahead the calendar is read when the lead named no window. */
const DEFAULT_HORIZON_DAYS = 7;

export type Proposed = { message: string; leadId: string | null; slots: Slot[] };

async function authorise(): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) return err('FORBIDDEN', 'Your role cannot offer or book a time; the owner or an ops admin can.');
  return ok(true);
}

type MeetingRow = {
  id: string;
  lead_id: string;
  status: string;
  requested_mode: string;
  requested_start_at: string | null;
  requested_window_end: string | null;
  timezone: string | null;
  proposed_slots: unknown;
  contact_id: string | null;
  leads: { title: string } | { title: string }[] | null;
  contacts: { email: string | null; full_name: string | null } | { email: string | null; full_name: string | null }[] | null;
};

async function readMeeting(id: string): Promise<Result<MeetingRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('meetings')
    .select('id, lead_id, status, requested_mode, requested_start_at, requested_window_end, timezone, proposed_slots, contact_id, leads(title), contacts(email, full_name)')
    .eq('id', id)
    .maybeSingle();
  if (error) return err('INTERNAL', `Could not read the meeting: ${error.message}`);
  if (!data) return err('NOT_FOUND', 'Meeting not found.');
  return ok(data as unknown as MeetingRow);
}

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

/**
 * §5 up to PROPOSE. The window is the one the lead named, widened to a day
 * on either side so "Tuesday afternoon" gets Tuesday's neighbours too, or
 * the next seven days when they named none.
 */
export async function proposeSlots(id: string, durationMinutes: number): Promise<Result<Proposed>> {
  const parsed = z.object({ id: meetingId, duration: z.number().int().min(5).max(480) }).safeParse({ id, duration: durationMinutes });
  if (!parsed.success) return err('VALIDATION', 'That is not a valid meeting, or the duration is outside 5 minutes to 8 hours.');
  const auth = await authorise();
  if (!auth.ok) return auth;
  const meeting = await readMeeting(parsed.data.id);
  if (!meeting.ok) return meeting;

  const calendar = createGoogleCalendar();
  if (!calendar) return err('VALIDATION', 'No calendar is configured, so nothing can be offered — availability answers unconfigured (BLK-005).');

  const now = new Date();
  const window = proposalWindow(now.toISOString(), { requestedStartAt: meeting.data.requested_start_at, requestedWindowEnd: meeting.data.requested_window_end }, DEFAULT_HORIZON_DAYS);

  const answer = await readAvailabilityFrom(calendar, { from: window.from, to: window.to });
  if (answer.state === 'unreadable') return err('INTERNAL', `The calendar did not answer: ${answer.reason}. Nothing was offered.`);
  if (answer.state !== 'read') return err('VALIDATION', 'No calendar is configured, so nothing can be offered.');

  const offer = offerableSlots(
    { ...answer, slots: sliceWindows(answer.slots, parsed.data.duration) },
    { requestedStartAt: meeting.data.requested_start_at, requestedWindowEnd: meeting.data.requested_window_end },
    { durationMinutes: parsed.data.duration, ...CONSTRAINTS },
    now.toISOString(),
  );
  const slots = offer.ok ? [...offer.slots] : [];

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('propose_meeting_slots', {
    p_meeting_id: parsed.data.id,
    p_slots: slots as unknown as Json,
    p_availability_source: `${answer.source.provider}:${answer.source.calendarId}`,
    p_availability_read_at: answer.readAt,
    p_duration_minutes: parsed.data.duration,
  });
  if (error) return err('INTERNAL', `Could not record the proposal: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; lead_id?: string | null } | undefined;
  const decision = interpretPropose(row?.outcome, slots.length);
  if (decision.kind === 'error') return err(decision.code, decision.message);
  return ok({
    message: window.fellBack ? `${decision.message} (The time the lead named has passed, so the next ${DEFAULT_HORIZON_DAYS} days were read instead.)` : decision.message,
    leadId: row?.lead_id ?? null,
    slots,
  });
}

export type Booked = { message: string; leadId: string | null; meetUrl: string | null };

/**
 * RECHECK → provider event → the row's door, on ONE of the slots that was
 * offered. A time nobody offered cannot be booked from here: the client
 * chose among what the calendar had, and "you may only offer what you read"
 * runs through to the booking.
 */
export async function bookProposedSlot(id: string, startAt: string, mode: string): Promise<Result<Booked>> {
  const parsed = z
    .object({ id: meetingId, startAt: z.string().datetime({ offset: true }), mode: z.enum(['call', 'video_meeting', 'in_person_meeting', 'other']) })
    .safeParse({ id, startAt, mode });
  if (!parsed.success) return err('VALIDATION', 'Choose one of the offered slots and a mode.');
  const auth = await authorise();
  if (!auth.ok) return auth;
  const meeting = await readMeeting(parsed.data.id);
  if (!meeting.ok) return meeting;

  const offered = (Array.isArray(meeting.data.proposed_slots) ? meeting.data.proposed_slots : []) as Slot[];
  const chosen = offered.find((s) => Date.parse(s.startAt) === Date.parse(parsed.data.startAt));
  if (!chosen) return err('VALIDATION', 'That time was not among the slots offered. Propose again if the client wants another.');

  const calendar = createGoogleCalendar();
  if (!calendar) return err('VALIDATION', 'No calendar is configured, so nothing can be booked (BLK-005).');

  // A slot offered days ago may be gone by the time somebody clicks: the
  // clock is re-asked too, not only the calendar (review).
  if (Date.parse(chosen.startAt) <= Date.now() + CONSTRAINTS.minimumNoticeMinutes * 60_000) {
    return err('VALIDATION', 'That slot is too soon or has passed. Propose again — nothing was booked.');
  }

  // §5.1 "Re-check availability immediately before committing the booking."
  // With the buffer the offer was filtered for: a neighbour that landed
  // beside the slot since it was offered is what the buffer exists to keep clear.
  const padded = bufferedSlot(chosen, CONSTRAINTS.bufferMinutes);
  const recheck = await readAvailabilityFrom(calendar, { from: padded.startAt, to: padded.endAt });
  const still = slotStillFree(recheck, padded);
  if (!still.free) {
    return err(
      'VALIDATION',
      still.reason === 'taken'
        ? 'That slot is no longer free on the calendar. Propose again — nothing was booked.'
        : still.reason === 'unreadable'
          ? `The calendar did not answer the re-check${recheck.state === 'unreadable' ? `: ${recheck.reason}` : ''}. Nothing was booked.`
          : 'No calendar is configured.',
    );
  }
  const supabase = await createClient();
  const noted = await supabase.schema('crm').rpc('note_availability_read', {
    p_meeting_id: parsed.data.id,
    p_availability_source: `${recheck.state === 'read' ? recheck.source.provider : 'google'}:${calendar.calendarId}`,
    p_availability_read_at: recheck.state === 'read' ? recheck.readAt : new Date().toISOString(),
  });
  const notedRow = (Array.isArray(noted.data) ? noted.data[0] : noted.data) as { outcome?: string } | undefined;
  if (noted.error || notedRow?.outcome !== 'noted') {
    return err('VALIDATION', `The re-check could not be recorded (${noted.error?.message ?? notedRow?.outcome ?? 'no answer'}); nothing was booked.`);
  }

  // §6.3: the provider event, through the adapter, BEFORE the row — and
  // cancelled again if the row refuses. The booking key is the meeting and
  // the slot, so a second click on the same slot is the same booking.
  const bookingKey = `meeting:${parsed.data.id}:${new Date(chosen.startAt).toISOString()}`;
  const lead = one(meeting.data.leads);
  const contact = one(meeting.data.contacts);
  // The meeting's own zone, else the agency's — never a constant (review).
  const zone = meeting.data.timezone ?? (await getAgencyTimeZone());
  const event = await calendar.createEvent({
    summary: `${lead?.title ?? 'Meeting'}${contact?.full_name ? ` — ${contact.full_name}` : ''}`,
    description: `Booked from AgencyOS (meeting ${parsed.data.id}).`,
    startAt: chosen.startAt,
    endAt: chosen.endAt,
    timezone: zone,
    requestId: bookingKey,
    ...(contact?.email ? { attendees: [{ email: contact.email }] } : {}),
    withMeet: parsed.data.mode === 'video_meeting',
  });
  if (!event.ok) return err('INTERNAL', `Google would not create the event: ${event.message}. Nothing was booked.`);
  if (parsed.data.mode === 'video_meeting' && event.meet !== 'created') {
    // A video meeting with no link is not the meeting agreed. The event is
    // taken back rather than left as a promise the client cannot join.
    await calendar.cancelEvent(event.eventId);
    return err('INTERNAL', `Google created the event but ${event.meet === 'pending' ? 'has not yet created' : 'could not create'} a Meet link, so it was cancelled again. Try once more, or book as a call.`);
  }

  const { data, error } = await supabase.schema('crm').rpc('book_meeting', {
    p_meeting_id: parsed.data.id,
    p_booking_key: bookingKey,
    p_start_at: chosen.startAt,
    p_end_at: chosen.endAt,
    p_timezone: zone,
    p_mode: parsed.data.mode,
    p_provider: calendar.id,
    p_provider_event_id: event.eventId,
    // Only a link the CLIENT can join is a meeting link. The agency's own
    // event page is not one, and A09 would have shown it as if it were.
    ...(event.meetUrl ? { p_meeting_url: event.meetUrl } : {}),
  });
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  const outcome = error ? undefined : row?.outcome;
  // A second submission racing the first: both created an event, the row
  // took one. The other is an orphan on the calendar unless taken back.
  if (outcome === 'already_booked') {
    const { data: bound } = await supabase.schema('crm').from('meetings').select('provider_event_id').eq('id', parsed.data.id).maybeSingle();
    if (bound?.provider_event_id && bound.provider_event_id !== event.eventId) {
      await calendar.cancelEvent(event.eventId);
    }
  }
  if (outcome !== 'booked' && outcome !== 'already_booked') {
    const taken = await calendar.cancelEvent(event.eventId);
    const compensation = taken.ok ? 'the calendar event was cancelled again' : `and the calendar event ${event.eventId} could NOT be cancelled: ${taken.message}`;
    if (error) return err('INTERNAL', `The row refused the booking (${error.message}); ${compensation}.`);
    const decision = interpretBook(outcome, null);
    return err(decision.kind === 'error' ? decision.code : 'INTERNAL', `${decision.kind === 'error' ? decision.message : outcome} — ${compensation}.`);
  }
  const decision = interpretBook(outcome, event.meetUrl);
  if (decision.kind === 'error') return err(decision.code, decision.message);
  return ok({ message: decision.message, leadId: meeting.data.lead_id, meetUrl: event.meetUrl });
}

export const PROPOSAL_DURATIONS = DEFAULT_DURATIONS;
