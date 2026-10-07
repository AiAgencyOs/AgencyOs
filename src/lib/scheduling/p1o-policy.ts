/**
 * Phase 1 Scheduler: the scheduling policy and the deterministic date and time reader (P1-SCHED-013/014/015/018/020/026).
 *
 * Pure. The policy is the one an administrator saved through `crm.p1o_set_scheduling_policy` (or the defaults the Scheduler used to hard-code when nothing was
 * saved). `withinWorkingHours` is the same rule `crm.p1o_within_working_hours` applies in the database. `resolveRelativeDate` reads "today", "tomorrow", "day
 * after tomorrow" and weekday names against the AGENCY-LOCAL date, rejects the past and never moves a date silently. It is a cross-check beside the model's
 * reading, not a replacement: when it cannot read a phrase it says so and a person (or the model) decides. Nothing here books or sends anything.
 */

export type HoursWindow = { start: string; end: string };
export type WorkingHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', HoursWindow[]>>;
export type Daypart = 'morning' | 'afternoon' | 'evening' | 'night';

export type SchedulingPolicy = {
  timezone: string;
  workingHours: WorkingHours | null;
  earliestLocalTime: string | null;
  latestLocalTime: string | null;
  dayparts: Partial<Record<Daypart, HoursWindow>>;
  minNoticeMinutes: number;
  bufferMinutes: number;
  durations: number[];
  proposalTtlHours: number;
  enforceWorkingHours: boolean;
  configured: boolean;
};

export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = {
  timezone: 'Asia/Kolkata',
  workingHours: null,
  earliestLocalTime: null,
  latestLocalTime: null,
  dayparts: { morning: { start: '09:00', end: '12:00' }, afternoon: { start: '12:00', end: '17:00' }, evening: { start: '17:00', end: '21:00' } },
  minNoticeMinutes: 60,
  bufferMinutes: 15,
  durations: [30, 45, 60],
  proposalTtlHours: 48,
  enforceWorkingHours: false,
  configured: false,
};

type Row = Record<string, unknown>;
const asNum = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A row of `crm.p1o_scheduling_policy_for` as the policy; anything unreadable falls back to the default for that field, never to an invented value. */
export function policyFromRow(row: Row | null | undefined): SchedulingPolicy {
  if (!row) return DEFAULT_SCHEDULING_POLICY;
  const d = DEFAULT_SCHEDULING_POLICY;
  return {
    timezone: typeof row.timezone === 'string' ? row.timezone : d.timezone,
    workingHours: row.working_hours && typeof row.working_hours === 'object' ? (row.working_hours as WorkingHours) : null,
    earliestLocalTime: typeof row.earliest_local_time === 'string' ? row.earliest_local_time.slice(0, 5) : null,
    latestLocalTime: typeof row.latest_local_time === 'string' ? row.latest_local_time.slice(0, 5) : null,
    dayparts: row.dayparts && typeof row.dayparts === 'object' ? (row.dayparts as SchedulingPolicy['dayparts']) : d.dayparts,
    minNoticeMinutes: asNum(row.min_notice_minutes, d.minNoticeMinutes),
    bufferMinutes: asNum(row.buffer_minutes, d.bufferMinutes),
    durations: Array.isArray(row.durations) && row.durations.every((x) => typeof x === 'number') ? (row.durations as number[]) : d.durations,
    proposalTtlHours: asNum(row.proposal_ttl_hours, d.proposalTtlHours),
    enforceWorkingHours: row.enforce_working_hours === true,
    configured: row.configured === true,
  };
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

type LocalParts = { year: number; month: number; day: number; weekday: number; minutes: number };

/** The wall-clock reading of an instant in an IANA zone. */
export function localParts(instant: Date, timeZone: string): LocalParts | null {
  if (Number.isNaN(instant.getTime())) return null;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  } catch {
    return null;
  }
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? '');
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m ?? 0);
};

/** The same rule as `crm.p1o_within_working_hours`: true when no hours are configured; a meeting must sit inside one window of ONE local day. */
export function withinWorkingHours(policy: SchedulingPolicy, startIso: string, endIso: string): boolean {
  if (!policy.workingHours) return true;
  const s = localParts(new Date(startIso), policy.timezone);
  const e = localParts(new Date(endIso), policy.timezone);
  if (!s || !e) return false;
  if (s.year !== e.year || s.month !== e.month || s.day !== e.day) return false;
  if (policy.earliestLocalTime && s.minutes < toMinutes(policy.earliestLocalTime)) return false;
  if (policy.latestLocalTime && e.minutes > toMinutes(policy.latestLocalTime)) return false;
  const windows = policy.workingHours[DAY_KEYS[s.weekday] as keyof WorkingHours] ?? [];
  return windows.some((w) => toMinutes(w.start) <= s.minutes && toMinutes(w.end) >= e.minutes);
}

export type Slot = { startAt: string; endAt: string };

/** Narrow what the calendar answered to the agency's own hours. Only ever shortens the list; with no hours configured it returns it whole. */
export function applyWorkingHours(policy: SchedulingPolicy, slots: readonly Slot[]): Slot[] {
  return slots.filter((s) => withinWorkingHours(policy, s.startAt, s.endAt));
}

/** "evening", "shaam"... as the policy's window; `null` when the word is not a daypart or the policy has no such window (a person decides). */
const DAYPART_WORDS: Record<string, Daypart> = {
  morning: 'morning', subah: 'morning', afternoon: 'afternoon', dopahar: 'afternoon', evening: 'evening', shaam: 'evening', night: 'night', raat: 'night',
};
export function daypartWindow(policy: SchedulingPolicy, word: string): HoursWindow | null {
  const key = DAYPART_WORDS[word.trim().toLowerCase()];
  return key ? (policy.dayparts[key] ?? null) : null;
}

export type DateReading =
  | { state: 'date'; date: string; basis: 'explicit' | 'relative' | 'weekday' }
  | { state: 'past'; date: string }
  | { state: 'none' }
  | { state: 'unclear'; why: string };

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, ravivar: 0, monday: 1, mon: 1, somvar: 1, tuesday: 2, tue: 2, tues: 2, mangalvar: 2, wednesday: 3, wed: 3, budhvar: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, guruvar: 4, friday: 5, fri: 5, shukravar: 5, saturday: 6, sat: 6, shanivar: 6,
};

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function addDays(y: number, m: number, d: number, days: number): string {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Resolve a date phrase against the agency-local date. Never silently moves a date: a past date is reported as past, not shifted; an ambiguous phrase is
 * `unclear`, not guessed. "tomorrow" and "kal" mean the next local day; "day after tomorrow" and "parso" two days on; a bare weekday is the NEXT such day
 * (today's name means a week from today, because a request for "Friday" on a Friday is for the next one).
 */
export function resolveRelativeDate(text: string, now: Date, timeZone: string): DateReading {
  const t = text.toLowerCase();
  const local = localParts(now, timeZone);
  if (!local) return { state: 'unclear', why: 'the timezone or the clock could not be read' };
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).getUTCDate() !== Number(iso[3])) return { state: 'unclear', why: 'that is not a calendar date' };
    return date < isoDate(local.year, local.month, local.day) ? { state: 'past', date } : { state: 'date', date, basis: 'explicit' };
  }
  if (/day after tomorrow|\bparso\b/.test(t)) return { state: 'date', date: addDays(local.year, local.month, local.day, 2), basis: 'relative' };
  if (/\btomorrow\b|\bkal\b/.test(t)) return { state: 'date', date: addDays(local.year, local.month, local.day, 1), basis: 'relative' };
  if (/\btoday\b|\baaj\b/.test(t)) return { state: 'date', date: isoDate(local.year, local.month, local.day), basis: 'relative' };
  const words = t.split(/[^a-z]+/).filter(Boolean);
  const named = words.filter((w) => w in WEEKDAYS);
  const distinct = new Set(named.map((w) => WEEKDAYS[w]));
  if (distinct.size > 1) return { state: 'unclear', why: 'more than one weekday is named' };
  if (distinct.size === 1) {
    const target = [...distinct][0] as number;
    const ahead = ((target - local.weekday + 7) % 7) || 7;
    return { state: 'date', date: addDays(local.year, local.month, local.day, ahead), basis: 'weekday' };
  }
  return { state: 'none' };
}

/** The offer's expiry for a policy, from the moment it is made. */
export function proposalExpiry(policy: SchedulingPolicy, madeAt: Date): Date {
  return new Date(madeAt.getTime() + policy.proposalTtlHours * 3_600_000);
}

/**
 * A cross-check beside the model's reading of a date (P1-SCHED-013): do the CLIENT'S OWN WORDS, read by rules, name the same local day as the instant the model
 * produced? `no_opinion` when the words hold no relative date or weekday (the model alone may read "the 14th"); `disagrees` only when the rules read a day and it is
 * a different one. A disagreement is not resolved here: the caller records the request without a time for a person to confirm, so a wrong guess never becomes a
 * booking window.
 */
export function modelDateAgrees(evidence: string, modelInstant: Date, now: Date, timeZone: string): 'agree' | 'disagrees' | 'no_opinion' {
  const reading = resolveRelativeDate(evidence, now, timeZone);
  if (reading.state !== 'date' || reading.basis === 'explicit') return 'no_opinion';
  const m = localParts(modelInstant, timeZone);
  if (!m) return 'no_opinion';
  return isoDate(m.year, m.month, m.day) === reading.date ? 'agree' : 'disagrees';
}
