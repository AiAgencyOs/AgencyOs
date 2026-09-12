import { MEETING_DOORS, type MeetingDoor } from '@/lib/scheduler/meeting-commands-eval';

import { MEETING_TRANSITIONS, isSettledMeeting, type MeetingStatus } from './schema';

/**
 * What the Scheduler screens may say — A08 (calendar) and A09 (meeting
 * detail), Admin Panel Blueprint p6–7 and Master Plan V3 §14/§15.
 *
 * Pure. Every sentence a screen shows about a meeting's time, conflicts,
 * reminder, analysis, provider or controls is decided here, from rows and a
 * clock, so it is executed by a unit test rather than read off a page.
 *
 * What a screen may DO is decided here too, from the state machine and the
 * doors that exist. Since G-237 the conclusions — cancel, complete, no-show —
 * plus typed evidence and the analysis request are commands whose doors
 * (`MEETING_DOORS`) the forms call; Blueprint §7 and §11 still forbid a button
 * that writes the row directly, so nothing here is a shortcut past them.
 * Booking, proposing and rescheduling stay BLOCKED: `crm.book_meeting` exists
 * but cannot be offered a slot because availability answers `unconfigured`
 * (BLK-005). The reminder and analysis jobs still have no worker behind them.
 * Blueprint §8 says a BLOCKED state names the blocker and its owner, and §11
 * says a hidden control is not enforcement — so every control is rendered,
 * either as the form that calls its door or as the blocker named.
 */

export type MeetingLike = {
  id: string;
  status: string;
  requested_mode: string;
  booked_mode: string | null;
  requested_start_at: string | null;
  requested_window_end: string | null;
  confirmed_start_at: string | null;
  confirmed_end_at: string | null;
  timezone: string | null;
  provider: string | null;
  provider_event_id: string | null;
  meeting_url: string | null;
  availability_source: string | null;
  availability_read_at: string | null;
  booked_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  completed_at: string | null;
  completed_by: string | null;
  outcome: string | null;
  supersedes_id: string | null;
};

export type JobLike = {
  status: string;
  run_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
};

/* ── zones ────────────────────────────────────────────────────────────── */

/**
 * `crm.meetings.timezone` is free text: no CHECK, and `crm.book_meeting`
 * tests only that it is not null. `Intl.DateTimeFormat` throws on a zone it
 * does not know, and a throw in a server component takes the whole page —
 * review found one bad row would take the calendar, the lead page and the
 * meeting page down for everyone in the organization. So a zone is tried
 * before it is used, and an unrecognised one is said on the card while the
 * agency's zone does the formatting.
 */
export function isKnownZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type ZonePair = { primary: string; secondary: string | null; unrecognised: string | null };

/** "Timezone always visible" (Blueprint A08): the meeting's zone first, the agency's beside it when different. */
export function timezonePair(meetingZone: string | null, agencyZone: string): ZonePair {
  if (meetingZone === null) return { primary: agencyZone, secondary: null, unrecognised: null };
  if (!isKnownZone(meetingZone)) return { primary: agencyZone, secondary: null, unrecognised: meetingZone };
  return { primary: meetingZone, secondary: meetingZone === agencyZone ? null : agencyZone, unrecognised: null };
}

/* ── the window A08 shows ─────────────────────────────────────────────── */

export const MEETING_WINDOWS = ['today', 'week', 'month', 'past'] as const;
export type MeetingWindowKey = (typeof MEETING_WINDOWS)[number];

export type MeetingWindow = { key: MeetingWindowKey; from: Date; to: Date; label: string; chip: string };

const DAY = 86_400_000;

/**
 * Midnight of `now`'s calendar day in `zone`, as an instant. The zone's wall
 * clock is read with Intl, the wall date is rebuilt as UTC, and the offset
 * between the two is the zone's offset at that moment. Exact everywhere the
 * offset does not change during the day, which is every zone the agency
 * has ever been in; a DST transition day is out by the shift, and said so
 * nowhere because no such zone is configured.
 */
export function startOfDayIn(zone: string, now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = wallAsUtc - now.getTime();
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - offset);
}

/**
 * Calendar windows in the agency's zone, so "Today" is the agency's today —
 * a meeting that began an hour ago is in it, not filed under the past.
 * Scheduler §15 asks for a calendar grid only "where configured", and no
 * calendar is; a day-grouped list over these windows is what can be shown.
 */
export function meetingWindow(param: string | undefined, now: Date, zone: string): MeetingWindow {
  const key: MeetingWindowKey = (MEETING_WINDOWS as readonly string[]).includes(param ?? '')
    ? (param as MeetingWindowKey)
    : 'week';
  const today = startOfDayIn(zone, now);
  switch (key) {
    case 'today':
      return { key, from: today, to: new Date(today.getTime() + DAY), label: `today (${zone})`, chip: 'Today' };
    case 'month':
      return { key, from: today, to: new Date(today.getTime() + 30 * DAY), label: `the next 30 days from today (${zone})`, chip: 'Next 30 days' };
    case 'past':
      return { key, from: new Date(today.getTime() - 30 * DAY), to: today, label: `the 30 days before today (${zone})`, chip: 'Last 30 days' };
    default:
      return { key: 'week', from: today, to: new Date(today.getTime() + 7 * DAY), label: `the next 7 days from today (${zone})`, chip: 'Next 7 days' };
  }
}

/* ── when ─────────────────────────────────────────────────────────────── */

export type MeetingWhen =
  | { kind: 'confirmed'; start: string; end: string | null }
  | { kind: 'requested'; start: string; end: string | null }
  | { kind: 'unscheduled' };

/**
 * A booked meeting has an agreed time; a requested one has what the client
 * asked for. They are kept apart on the row (Scheduler §4.1) and stay apart
 * here: the screen says which one it is showing.
 */
export function whenOf(m: Pick<MeetingLike, 'requested_start_at' | 'requested_window_end' | 'confirmed_start_at' | 'confirmed_end_at'>): MeetingWhen {
  if (m.confirmed_start_at) return { kind: 'confirmed', start: m.confirmed_start_at, end: m.confirmed_end_at };
  if (m.requested_start_at) return { kind: 'requested', start: m.requested_start_at, end: m.requested_window_end };
  return { kind: 'unscheduled' };
}

/** The instant a card sorts and groups by; null when there is none or it cannot be parsed. */
export function sortInstant(m: MeetingLike): number | null {
  const w = whenOf(m);
  if (w.kind === 'unscheduled') return null;
  const t = Date.parse(w.start);
  return Number.isFinite(t) ? t : null;
}

/** Cards grouped by the day they fall on, in the caller's chosen zone; the timeless ones last. */
export function groupByDay<T extends MeetingLike>(
  rows: readonly T[],
  dayKey: (iso: string) => string,
): { day: string | null; rows: T[] }[] {
  const timed = rows
    .map((row) => ({ row, at: sortInstant(row) }))
    .filter((x): x is { row: T; at: number } => x.at !== null)
    .sort((a, b) => a.at - b.at);
  const groups = new Map<string, T[]>();
  for (const { row } of timed) {
    const w = whenOf(row);
    const key = w.kind === 'unscheduled' ? '' : dayKey(w.start);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: { day: string | null; rows: T[] }[] = [...groups.entries()].map(([day, list]) => ({ day, rows: list }));
  const unscheduled = rows.filter((r) => sortInstant(r) === null);
  if (unscheduled.length > 0) out.push({ day: null, rows: unscheduled });
  return out;
}

/* ── conflicts ────────────────────────────────────────────────────────── */

/**
 * Blueprint A08: "Conflict indicators without private calendar details."
 * Computed from AgencyOS's own booked rows only — no provider calendar is
 * read, and `crm.book_meeting` deliberately does not prevent overlap because
 * nothing says which owner or room two meetings would compete for. So this
 * is "two bookings overlap in time", said exactly that way, and nothing more.
 * Half-open intervals: a meeting ending at 10:00 does not conflict with one
 * starting at 10:00.
 */
export function bookedOverlaps(rows: readonly MeetingLike[]): Map<string, string[]> {
  const booked = rows
    .filter((r) => r.status === 'booked' && r.confirmed_start_at && r.confirmed_end_at)
    .map((r) => ({ id: r.id, start: Date.parse(r.confirmed_start_at!), end: Date.parse(r.confirmed_end_at!) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
  const out = new Map<string, string[]>();
  for (const a of booked) {
    for (const b of booked) {
      if (a.id === b.id) continue;
      if (a.start < b.end && b.start < a.end) out.set(a.id, [...(out.get(a.id) ?? []), b.id]);
    }
  }
  return out;
}

/* ── the sentences ────────────────────────────────────────────────────── */

export type Said = { text: string; tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success' };

/** Blueprint A09 "Provider event/link". Null provider is the deployment with no calendar (BLK-005), not an error. */
export function providerState(m: Pick<MeetingLike, 'provider' | 'provider_event_id' | 'meeting_url'>): Said {
  if (!m.provider) {
    return { text: 'No calendar provider is configured (BLK-005) — nothing was written to an external calendar.', tone: 'warning' };
  }
  const event = m.provider_event_id ? ` · event ${m.provider_event_id}` : ' · no event id recorded';
  return { text: `${m.provider}${event}`, tone: m.provider_event_id ? 'success' : 'warning' };
}

/** G-226: what the slot offer was read from, when. A key, not a proof the calendar was right. */
export function availabilityState(m: Pick<MeetingLike, 'availability_source' | 'availability_read_at'>): Said {
  if (!m.availability_source) return { text: 'No availability was read for this meeting.', tone: 'neutral' };
  return { text: `Availability read from ${m.availability_source}${m.availability_read_at ? ` at ${m.availability_read_at}` : ''}.`, tone: 'neutral' };
}

/**
 * One job per meeting, chosen the same way on every screen: the newest by
 * `created_at`. Review found the calendar keeping the oldest (a Map built
 * from a newest-first list keeps the last entry) while the detail page kept
 * the newest, so the two said different things about one meeting.
 */
export function pickNewest<T extends { created_at: string }>(jobs: readonly T[]): T | null {
  let best: T | null = null;
  for (const job of jobs) if (!best || job.created_at > best.created_at) best = job;
  return best;
}

/**
 * Blueprint A08 "Reminder status", A09 "Reminder jobs". A queued
 * `meeting.reminder` row is a row nothing drains — no sender is registered
 * for the kind — and the sentence says so rather than implying a send. A
 * cancelled, settled or unbooked meeting legitimately has no reminder
 * (`crm.drop_stale_meeting_reminders`); that is not an absence to worry about.
 */
export function reminderState(job: JobLike | null, m: Pick<MeetingLike, 'status'>): Said {
  if (m.status !== 'booked') {
    return { text: `No reminder — the meeting is ${m.status.replace('_', ' ')}, and reminders exist only for a booked one.`, tone: 'neutral' };
  }
  if (!job) return { text: 'No reminder is scheduled.', tone: 'neutral' };
  switch (job.status) {
    case 'queued':
      return { text: `Queued for ${job.run_at ?? 'an unknown time'} — no sender is registered for this job kind yet, so it will not go out.`, tone: 'warning' };
    case 'running':
      return { text: 'A reminder job is running.', tone: 'info' };
    case 'succeeded':
      return { text: 'The reminder job ran.', tone: 'success' };
    case 'failed':
    case 'dead':
      return { text: `The reminder job ${job.status === 'dead' ? 'was parked' : 'failed'} after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}${job.last_error ? `: ${job.last_error}` : '.'}`, tone: 'danger' };
    default:
      return { text: `Reminder job is ${job.status}.`, tone: 'neutral' };
  }
}

/**
 * Blueprint A09 "AI analysis state/outcome". `crm.request_meeting_analysis`
 * (G-229) refuses anything but a completed meeting with evidence; a queued
 * job cannot run until an AI provider is chosen (BLK-001). Never a summary:
 * there is none, and one would be inference, born `proposed`, if there were.
 */
export function analysisState(job: JobLike | null, m: Pick<MeetingLike, 'status'>, evidenceCount: number): Said {
  if (m.status !== 'completed') return { text: 'Not requestable — the meeting is not marked completed (only a person can mark it).', tone: 'neutral' };
  if (evidenceCount === 0) return { text: 'Not requestable — no evidence is attached, and a model asked to summarise an empty room would still answer.', tone: 'neutral' };
  if (!job) return { text: 'Not requested.', tone: 'neutral' };
  if (job.status === 'queued') return { text: `Requested ${job.created_at}; queued — the runner takes it on its next tick and reads the typed evidence (G-239).`, tone: 'info' };
  if (job.status === 'succeeded') return { text: `Analysed — the proposed summary is filed below as internal evidence, and a proposed requirement version is on the thread where one exists. Nothing in it is confirmed until a person confirms it (§10.3).`, tone: 'success' };
  if (job.status === 'failed' || job.status === 'dead') return { text: `The analysis job ${job.status === 'dead' ? 'was parked' : 'failed'}${job.last_error ? `: ${job.last_error}` : '.'}`, tone: 'danger' };
  return { text: `Analysis job is ${job.status}.`, tone: 'info' };
}

/** Blueprint A09 "Completion state" — from the row only, never from the clock (§9.1). */
export function completionState(m: Pick<MeetingLike, 'status' | 'completed_at' | 'completed_by' | 'outcome' | 'confirmed_end_at'>, now: Date): Said {
  if (m.status === 'completed') {
    return { text: `Completed${m.outcome ? ` — ${m.outcome.replace(/_/g, ' ')}` : ''}${m.completed_at ? ` at ${m.completed_at}` : ''}${m.completed_by ? ` by ${m.completed_by.slice(0, 8)}` : ''}.`, tone: 'success' };
  }
  if (m.status === 'no_show') return { text: `Recorded as a no-show${m.completed_at ? ` at ${m.completed_at}` : ''}.`, tone: 'warning' };
  if (m.status === 'cancelled') return { text: 'Cancelled — nothing happened, and nothing was marked completed.', tone: 'neutral' };
  if (m.status === 'booked' && m.confirmed_end_at && Date.parse(m.confirmed_end_at) < now.getTime()) {
    return { text: 'Booked — the end time has passed and nobody has marked it completed. Time passing is not completion.', tone: 'warning' };
  }
  return { text: `Not completed — the meeting is ${m.status.replace('_', ' ')}.`, tone: 'neutral' };
}

/** A09's evidence badge: the vocabulary the CHECK holds, not a guess at it. */
export function evidenceTone(visibility: string): Said['tone'] {
  return visibility === 'client_visible' ? 'info' : 'neutral';
}

/* ── the controls, each either a command or a blocker named ────────────── */

export type MeetingControl = {
  action: string;
  target: MeetingStatus | null;
  /** `command`: a door exists and the form calls it. `blocked`: it does not, and the reason says on what. */
  state: 'command' | 'blocked';
  /** The door, from the one table the lib calls through; null when blocked on the calendar. */
  door: MeetingDoor | null;
  reason: string;
  owner: string;
};

const BLOCKED_ON_CALENDAR = (action: string, target: MeetingStatus, what: string): MeetingControl => ({
  action,
  target,
  state: 'blocked',
  door: null,
  reason: `crm.book_meeting exists but cannot be offered a slot — availability answers unconfigured (BLK-005), and a ${what} that invents a time is what G-226 refuses`,
  owner: 'the owner (choose a calendar provider)',
});

const COMMAND = (door: MeetingDoor, target: MeetingStatus | null, reason: string): MeetingControl => ({
  action: MEETING_DOORS[door].action,
  target,
  state: 'command',
  door,
  reason,
  owner: 'you',
});

/**
 * Derived from the state machine, so a status can never offer a move the
 * database refuses, and every legal move has a control. The conclusions —
 * cancel, complete, no-show — are commands naming their door; booking,
 * proposing and rescheduling stay BLOCKED for the reason they always were:
 * the booking door exists and cannot be offered a slot (BLK-005), and a time
 * invented to fill a form is what G-226 refuses. Review of G-234 caught the
 * first draft telling the operator `crm.book_meeting` did not exist; the
 * sentence is kept.
 *
 * A settled meeting still takes evidence — what a cancelled meeting left
 * behind is still evidence, and `crm.add_meeting_evidence` accepts it — and a
 * completed one may ask the analysis gate again, because a completion with
 * no note answers `no_evidence` and review found the first draft leaving no
 * way back to §9.3's chain from the page.
 */
export function meetingControls(status: MeetingStatus): MeetingControl[] {
  const out: MeetingControl[] = [];
  if (!isSettledMeeting(status)) {
    // A reschedule is not a transition — it mints a new row carrying
    // supersedes_id (§8) — so it is not in the map, and it is named here.
    if (status === 'booked') out.push(BLOCKED_ON_CALENDAR('Reschedule', 'booked', 'reschedule'));
    for (const target of MEETING_TRANSITIONS[status] ?? []) {
      if (target === 'booked' || target === 'proposed') {
        out.push(BLOCKED_ON_CALENDAR(status === 'booked' ? 'Reschedule' : target === 'booked' ? 'Book' : 'Propose a time', target, 'booking'));
      } else if (target === 'cancelled') {
        out.push(COMMAND('crm.cancel_meeting', target, 'history is kept on the row; the queued reminder is dropped; a provider event is NOT cancelled at the provider (BLK-005)'));
      } else if (target === 'completed') {
        out.push(COMMAND('crm.complete_meeting', target, 'you and the moment are recorded; never before the agreed start; a note becomes internal evidence and the analysis gate is asked'));
      } else if (target === 'no_show') {
        out.push(COMMAND('crm.record_no_show', target, 'you and the moment are recorded; never before the agreed start; no follow-up is queued (ADM-103)'));
      }
    }
  }
  out.push(COMMAND('crm.add_meeting_evidence', null, 'typed notes and summaries only — no artifact store is chosen to sign a reference (G-229), so a file cannot be attached honestly yet'));
  if (status === 'completed') {
    out.push(COMMAND('crm.request_meeting_analysis', null, 'asks G-229\'s gate again: refused without evidence, queued once with it — and it stays queued, since no worker runs one (BLK-001)'));
  }
  return out;
}
