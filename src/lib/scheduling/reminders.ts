/**
 * A reminder for a meeting that moved — gap G-228.
 *
 * Scheduler specification §7.2 asks for five things a reminder must do, and
 * three of them are about the reminder being WRONG by the time it fires:
 *
 *   "Re-check current schedule state immediately before sending."
 *   "Suppress reminders for cancelled events."
 *   "Replace obsolete reminders after rescheduling."
 *
 * Sales Flow §6 says the same from the client's side: "A reminder must be
 * re-checked at execution time so it does not fire after the event is
 * cancelled/rescheduled."
 *
 * ── the lesson this is an instance of ─────────────────────────────────────
 *
 * G-191 was exactly this failure in the outbound worker: the sending window
 * was applied when the message was SCHEDULED and never again, so a follow-up
 * computed at 18:00 arrived at three in the morning. The fix was to ask the
 * same question again at the moment of sending. A reminder is the same shape
 * with a worse blast radius, because the client has been told somebody is
 * coming.
 *
 * So the decision is made twice, deliberately: once to work out when the job
 * should run, and again — here — against the row as it is when it does.
 *
 * ── why the scheduled time travels with the job ───────────────────────────
 *
 * A reschedule mints a NEW meeting row (G-225 §8) and cancels the old one, so
 * a stale reminder usually dies on `status`. But a booking can also be moved
 * in place, and then the row is still `booked` and still valid — only at a
 * different time. Carrying the start the reminder was computed against is what
 * lets `reminderVerdict` tell "this meeting is at four" from "this reminder is
 * about a four o'clock meeting that is now at six".
 */

/** What the job was scheduled against, carried in its payload. */
export type ReminderJob = {
  meetingId: string;
  /** The meeting start this reminder was computed from, ISO-8601. */
  scheduledForStartAt: string;
  /** How far ahead of the meeting it was meant to fire. */
  leadMinutes: number;
};

/** The meeting as it is NOW, re-read at fire time. */
export type MeetingNow = {
  status: 'requested' | 'proposed' | 'booked' | 'completed' | 'no_show' | 'cancelled';
  confirmedStartAt: string | null;
};

export type ReminderVerdict =
  | 'send'
  /** §7.2 "Suppress reminders for cancelled events." */
  | 'cancelled'
  /** The meeting left `booked` some other way — completed early, or never booked. */
  | 'not_booked'
  /** §7.2 "Replace obsolete reminders after rescheduling." */
  | 'moved'
  /** Fired before its window — the queue ran early, or the clock moved. */
  | 'too_early'
  /** Fired after the meeting began. Worse than not reminding at all. */
  | 'too_late';

const MINUTE = 60_000;

/**
 * When a reminder should run.
 *
 * Returns null when there is nothing to remind about — an unbooked meeting has
 * no time to count back from, and inventing one is how a reminder fires for a
 * meeting nobody agreed to.
 */
export function reminderDueAt(
  meeting: { status: MeetingNow['status']; confirmedStartAt: string | null },
  leadMinutes: number,
): string | null {
  if (meeting.status !== 'booked') return null;
  if (!meeting.confirmedStartAt) return null;

  const start = Date.parse(meeting.confirmedStartAt);
  if (!Number.isFinite(start)) return null;
  if (leadMinutes <= 0) return null;

  return new Date(start - leadMinutes * MINUTE).toISOString();
}

/**
 * The re-check, at the moment of sending.
 *
 * Ordered so the most important refusals answer first: a cancelled meeting is
 * cancelled whatever the clock says, and a moved one is stale whether or not
 * its old time has arrived. Only after those does the window matter.
 *
 * `graceMinutes` is how late a reminder may still be useful. Past it the
 * meeting has begun, and a reminder then is not a reminder — it is a message
 * telling somebody to attend a thing they are already late for.
 */
export function reminderVerdict(
  job: ReminderJob,
  meeting: MeetingNow,
  now: string,
  graceMinutes = 2,
): ReminderVerdict {
  if (meeting.status === 'cancelled') return 'cancelled';
  if (meeting.status !== 'booked') return 'not_booked';
  if (!meeting.confirmedStartAt) return 'not_booked';

  // The whole point: the meeting is still on, but not when this reminder
  // thought. The reminder computed for the new time is the one that should
  // fire, and this one must not.
  // Compared as INSTANTS. Postgres renders a timestamptz one way
  // (`+05:30`, six fractional digits) and a JavaScript row another (`Z`,
  // three), and the first draft compared the strings — so a job whose payload
  // came from the database against a row normalised by the client answered
  // 'moved' for a meeting that had not. An unparseable start is not a booking.
  const start = Date.parse(meeting.confirmedStartAt);
  const at = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return 'not_booked';
  const scheduledFor = Date.parse(job.scheduledForStartAt);
  if (!Number.isFinite(scheduledFor) || scheduledFor !== start) return 'moved';

  const due = start - job.leadMinutes * MINUTE;
  if (at < due) return 'too_early';
  if (at > start + graceMinutes * MINUTE) return 'too_late';

  return 'send';
}

/**
 * The job's dedupe key.
 *
 * `core.jobs.dedupe_key` is unique, so this is what makes re-scheduling a
 * reminder REPLACE rather than accumulate — §7.2's "Use stable job IDs and
 * idempotency keys" and "Replace obsolete reminders after rescheduling", in
 * one string.
 *
 * Keyed on the meeting and the lead time and NOT on the start: a key carrying
 * the start would mint a fresh job every time a meeting moved and leave the
 * old one queued, which is the accumulation this is meant to prevent. The
 * start travels in the payload instead, where `reminderVerdict` reads it.
 */
export function reminderDedupeKey(meetingId: string, leadMinutes: number): string {
  return `meeting.reminder:${meetingId}:${leadMinutes}`;
}

/**
 * §7.2's "Create reminder jobs from configured policy", and nothing more.
 *
 * Sales Flow §6 gives 5–10 minutes as the user's stated target and says
 * plainly that "exact policy can be configurable" — so the default here is the
 * far end of the range the owner named, and it is a default rather than a
 * rule. An organization that has set its own value passes it in.
 */
export const DEFAULT_REMINDER_LEAD_MINUTES = 10;

/** Bounds a configured lead time. Zero would mean "remind at the meeting". */
export function clampLeadMinutes(requested: number | null | undefined): number {
  const value = requested ?? DEFAULT_REMINDER_LEAD_MINUTES;
  if (!Number.isFinite(value)) return DEFAULT_REMINDER_LEAD_MINUTES;
  // A day ahead is the far end of useful; past that it is not a reminder, it
  // is a separate message about next week.
  return Math.min(Math.max(Math.trunc(value), 1), 1_440);
}
