import { z } from 'zod';

import type { createAdminClient } from '@/lib/db/admin';
import { reminderVerdict } from '@/lib/scheduling/reminders';

import { announceToInternalChannel, type AnnounceJob, type HandlerResult } from './handlers';

/**
 * P1-SCHED-030 / P1-FLOW-028..032. The admin hears about a meeting.
 *
 *   * `meeting.booked`     -> an internal-channel announcement of who, when and why (the staff relay to the client over WhatsApp as everywhere else).
 *   * `meeting.cancelled`  -> an announcement, only when the meeting HAD been booked (cancelling a mere request is not news).
 *   * `meeting.reminder`   -> the sender the queue never had: re-runs `reminderVerdict` AT FIRE TIME (a cancelled or moved meeting sends nothing) and only
 *                            then announces. Until this existed `meetings-view.ts` truthfully said "no sender is registered for this job kind".
 *
 * Row authority over event payload: the event or job names a meeting; the handler re-reads it for the JOB's organization and announces what the ROW says.
 * Nothing is sent to the CLIENT from here; delivery of the announcement is the existing outbound path (and so needs the WhatsApp number, BLK-003).
 */

type Admin = ReturnType<typeof createAdminClient>;

const eventSchema = z.object({ meetingId: z.uuid(), wasBooked: z.boolean().optional() }).strip();
const reminderPayloadSchema = z
  .object({ meeting_id: z.uuid(), scheduled_for_start_at: z.string().min(1), lead_minutes: z.number().int().min(1).max(1440) })
  .strip();

export type ReminderJobRow = { id: string; organization_id: string; payload: unknown; correlation_id: string | null };

type MeetingRow = {
  id: string;
  lead_id: string;
  status: string;
  confirmed_start_at: string | null;
  timezone: string | null;
  booked_mode: string | null;
  purpose: string | null;
  cancellation_reason: string | null;
};

async function readMeeting(admin: Admin, organizationId: string, meetingId: string): Promise<{ meeting: MeetingRow | null; leadTitle: string | null; error: string | null }> {
  const { data, error } = await admin
    .schema('crm')
    .from('meetings')
    .select('id, lead_id, status, confirmed_start_at, timezone, booked_mode, purpose, cancellation_reason')
    .eq('id', meetingId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) return { meeting: null, leadTitle: null, error: error.message };
  if (!data) return { meeting: null, leadTitle: null, error: null };
  const meeting = data as MeetingRow;
  const { data: lead, error: leadError } = await admin
    .schema('crm')
    .from('leads')
    .select('title')
    .eq('id', meeting.lead_id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (leadError) return { meeting, leadTitle: null, error: leadError.message };
  return { meeting, leadTitle: (lead as { title: string | null } | null)?.title ?? null, error: null };
}

/** The time as the meeting's own zone reads it, never the server's. */
export function meetingWhen(startAt: string | null, timezone: string | null): string {
  if (!startAt) return 'a time that is not set';
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) return 'a time that is not set';
  try {
    return `${d.toLocaleString('en-IN', { timeZone: timezone ?? 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} (${timezone ?? 'Asia/Kolkata'})`;
  } catch {
    return d.toISOString();
  }
}

export function meetingBookedAnnouncementFor(input: { leadTitle: string | null; when: string; mode: string | null; purpose: string | null }): string {
  return [
    'A meeting is booked.',
    `Lead: ${input.leadTitle ?? 'an unnamed lead'}`,
    `When: ${input.when}`,
    `Mode: ${(input.mode ?? 'not set').replace('_', ' ')}`,
    ...(input.purpose ? [`Purpose: ${input.purpose}`] : []),
    'Open the meeting in AgencyOS.',
  ].join('\n');
}

export function meetingCancelledAnnouncementFor(input: { leadTitle: string | null; when: string; reason: string | null }): string {
  return [
    'A booked meeting was cancelled.',
    `Lead: ${input.leadTitle ?? 'an unnamed lead'}`,
    `Was: ${input.when}`,
    ...(input.reason ? [`Reason: ${input.reason}`] : []),
  ].join('\n');
}

export function meetingReminderFor(input: { leadTitle: string | null; when: string; mode: string | null; minutes: number }): string {
  return [
    `Reminder: a meeting starts in about ${input.minutes} minute${input.minutes === 1 ? '' : 's'}.`,
    `Lead: ${input.leadTitle ?? 'an unnamed lead'}`,
    `When: ${input.when}`,
    `Mode: ${(input.mode ?? 'not set').replace('_', ' ')}`,
  ].join('\n');
}

export async function announceMeetingBooked(admin: Admin, job: AnnounceJob): Promise<HandlerResult> {
  const parsed = eventSchema.safeParse(job.payload?.event);
  if (!parsed.success) return { status: 'failed', permanent: true, detail: `malformed meeting.booked payload: ${parsed.error.issues[0]?.message ?? 'unparseable'}` };
  const read = await readMeeting(admin, job.organization_id, parsed.data.meetingId);
  if (read.error) return { status: 'failed', permanent: false, detail: `could not read the meeting: ${read.error}` };
  if (!read.meeting) return { status: 'succeeded', outcome: 'not_mine', detail: 'the meeting no longer exists' };
  if (read.meeting.status !== 'booked') return { status: 'succeeded', outcome: 'not_mine', detail: `the meeting is ${read.meeting.status}, not booked` };
  const when = meetingWhen(read.meeting.confirmed_start_at, read.meeting.timezone);
  return announceToInternalChannel(admin, job, {
    body: meetingBookedAnnouncementFor({ leadTitle: read.leadTitle, when, mode: read.meeting.booked_mode, purpose: read.meeting.purpose }),
    externalRef: `meeting-booked:${read.meeting.id}:${read.meeting.confirmed_start_at ?? 'unset'}`,
    notificationClass: 'sales',
  });
}

export async function announceMeetingCancelled(admin: Admin, job: AnnounceJob): Promise<HandlerResult> {
  const parsed = eventSchema.safeParse(job.payload?.event);
  if (!parsed.success) return { status: 'failed', permanent: true, detail: `malformed meeting.cancelled payload: ${parsed.error.issues[0]?.message ?? 'unparseable'}` };
  if (parsed.data.wasBooked !== true) return { status: 'succeeded', outcome: 'not_mine', detail: 'a meeting that was never booked is not announced' };
  const read = await readMeeting(admin, job.organization_id, parsed.data.meetingId);
  if (read.error) return { status: 'failed', permanent: false, detail: `could not read the meeting: ${read.error}` };
  if (!read.meeting) return { status: 'succeeded', outcome: 'not_mine', detail: 'the meeting no longer exists' };
  if (read.meeting.status !== 'cancelled') return { status: 'succeeded', outcome: 'not_mine', detail: `the meeting is ${read.meeting.status}, not cancelled` };
  return announceToInternalChannel(admin, job, {
    body: meetingCancelledAnnouncementFor({
      leadTitle: read.leadTitle,
      when: meetingWhen(read.meeting.confirmed_start_at, read.meeting.timezone),
      reason: read.meeting.cancellation_reason,
    }),
    externalRef: `meeting-cancelled:${read.meeting.id}`,
    notificationClass: 'sales',
  });
}

/**
 * The `meeting.reminder` sender. The verdict is re-run at the moment of sending, against the row, so a reminder for a meeting that moved or was cancelled is
 * dropped instead of sent. `too_early` is a retryable failure (the queue ran before the window); every other non-send verdict is a settled success.
 */
export async function sendMeetingReminder(admin: Admin, job: ReminderJobRow, now: string = new Date().toISOString()): Promise<HandlerResult> {
  const parsed = reminderPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { status: 'failed', permanent: true, detail: `malformed meeting.reminder payload: ${parsed.error.issues[0]?.message ?? 'unparseable'}` };
  const read = await readMeeting(admin, job.organization_id, parsed.data.meeting_id);
  if (read.error) return { status: 'failed', permanent: false, detail: `could not read the meeting: ${read.error}` };
  if (!read.meeting) return { status: 'succeeded', outcome: 'dropped', detail: 'the meeting no longer exists' };

  const verdict = reminderVerdict(
    { meetingId: read.meeting.id, scheduledForStartAt: parsed.data.scheduled_for_start_at, leadMinutes: parsed.data.lead_minutes },
    { status: read.meeting.status as 'booked', confirmedStartAt: read.meeting.confirmed_start_at },
    now,
  );
  if (verdict === 'too_early') return { status: 'failed', permanent: false, detail: 'fired before its window; try again later' };
  if (verdict !== 'send') return { status: 'succeeded', outcome: `dropped_${verdict}`, detail: `reminder not sent: ${verdict}` };

  const announceJob: AnnounceJob = { id: job.id, organization_id: job.organization_id, payload: null, correlation_id: job.correlation_id };
  return announceToInternalChannel(admin, announceJob, {
    body: meetingReminderFor({
      leadTitle: read.leadTitle,
      when: meetingWhen(read.meeting.confirmed_start_at, read.meeting.timezone),
      mode: read.meeting.booked_mode,
      minutes: parsed.data.lead_minutes,
    }),
    externalRef: `meeting-reminder:${read.meeting.id}:${parsed.data.lead_minutes}:${read.meeting.confirmed_start_at ?? 'unset'}`,
    notificationClass: 'meeting_reminder',
  });
}
