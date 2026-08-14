/**
 * When a follow-up is due — decision ADM-69, gap G-012.
 *
 * ADM-69 granted **rhythms rather than a cadence per situation**: eight
 * situations point at four reusable schedules. This module is the arithmetic
 * and nothing else. It sends nothing, reads no database, and decides only
 * *when* — so it can be exercised exhaustively without a clock, a tenant or a
 * provider.
 *
 * ── the recorded values, used rather than reinterpreted ───────────────────
 *
 *   Sales-Active      days 2, 5, 8, 11, 14, 17, 20
 *   Sales-Nurture     days 7, 14, 21, 28, 35, 42, 49  (weekly, 7 → 49)
 *   Customer-Success  days 7 and 21
 *   Internal-Approval every 1 business day, and see the SLA rule below
 *
 * **Day 0 is the trigger and is not an attempt.** Every number is a
 * **business** day — Monday to Friday — and the sending window is 10:00–19:00
 * local. Anything falling outside moves to the next eligible business sending
 * time rather than being sent early or dropped.
 *
 * The maxima were raised to **7** by the owner's correction, after the first
 * draft gave "maximum 3" while listing only two sends. Customer-Success keeps
 * two because two is what it lists.
 *
 * ── the SLA outranks the reminder count ───────────────────────────────────
 *
 * ADM-69 resolved this explicitly. `request_approval` already sets
 * `sla_due_at`, and three reminders at one business day each would chase a
 * request the system considers expired. **The SLA is the hard deadline and
 * always takes precedence**: once it has passed there is no next reminder,
 * whatever the attempt count says.
 *
 * ── what this module refuses to guess ─────────────────────────────────────
 *
 * ADM-69 says "contact timezone when known and agency timezone otherwise".
 * **Neither is stored anywhere in this schema** — there is no timezone column
 * on contacts, organizations or anything else. So `timeZone` is a required
 * argument with no default: a default here would be an invented production
 * fact, and the wrong one silently sends at the wrong hour in every
 * deployment. That missing column is recorded as its own gap.
 */

export type Rhythm =
  | 'sales_active'
  | 'sales_nurture'
  | 'customer_success'
  | 'internal_approval';

/**
 * The business-day offsets each rhythm fires on, exactly as ADM-69 records
 * them. Day 0 is the trigger and appears in none of them.
 */
export const RHYTHM_DAYS: Record<Rhythm, readonly number[]> = {
  sales_active: [2, 5, 8, 11, 14, 17, 20],
  sales_nurture: [7, 14, 21, 28, 35, 42, 49],
  customer_success: [7, 21],
  // "1 business day, up to 3 reminders" — and the SLA cuts it short whenever
  // it falls first, which in practice it usually will.
  internal_approval: [1, 2, 3],
};

/** The sending window, local to `timeZone`. Inclusive start, exclusive end. */
export const WINDOW_START_HOUR = 10;
export const WINDOW_END_HOUR = 19;

/** How many attempts a rhythm makes. Never more than the days it lists. */
export function maxAttempts(rhythm: Rhythm): number {
  return RHYTHM_DAYS[rhythm].length;
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * The wall-clock reading of an instant in a zone.
 *
 * `Intl` is used rather than arithmetic on the UTC offset because an offset is
 * not a constant: a zone that observes daylight saving has two of them, and
 * "10:00 local" means different instants either side of the change. Doing this
 * by hand is how a scheduler sends at 09:00 for half the year.
 */
function partsIn(instant: Date, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const found: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) found[part.type] = part.value;
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    hour: Number(found.hour),
    minute: Number(found.minute),
    weekday: WEEKDAY_INDEX[found.weekday ?? 'Sun'] ?? 0,
  };
}

/** Whether an instant falls on a business day in that zone. */
function isBusinessDay(instant: Date, timeZone: string): boolean {
  const weekday = partsIn(instant, timeZone).weekday;
  return weekday >= 1 && weekday <= 5;
}

const DAY_MS = 86_400_000;

/**
 * The instant of `hour:00` local on the calendar day `instant` falls in.
 *
 * Found by search rather than by constructing a date from an offset, for the
 * same reason `partsIn` exists: the offset is not knowable without the zone's
 * rules, and those change twice a year in many zones. Two passes converge
 * because a zone's offset is stable within an hour of the target.
 */
function atLocalHour(instant: Date, timeZone: string, hour: number): Date {
  let guess = new Date(instant.getTime());
  for (let i = 0; i < 3; i += 1) {
    const p = partsIn(guess, timeZone);
    const driftMinutes = (p.hour - hour) * 60 + p.minute;
    if (driftMinutes === 0) break;
    guess = new Date(guess.getTime() - driftMinutes * 60_000);
  }
  return guess;
}

/** Advance to the next calendar day, then keep going until it is a weekday. */
function nextBusinessDay(instant: Date, timeZone: string): Date {
  let next = new Date(instant.getTime() + DAY_MS);
  let guard = 0;
  while (!isBusinessDay(next, timeZone)) {
    next = new Date(next.getTime() + DAY_MS);
    guard += 1;
    // A week of non-business days cannot happen; if it does, something is
    // wrong with the zone rather than with the loop, and spinning would hide
    // it.
    if (guard > 7) throw new Error(`no business day found within a week in ${timeZone}`);
  }
  return next;
}

/**
 * Move an instant into the next eligible sending time.
 *
 * Before the window on a business day → the same day at the window's start.
 * At or after the window, or on a weekend → the next business day's start.
 *
 * Never moves a send *earlier*. A message that is late is a message; a message
 * sent at 07:00 because the arithmetic rounded the wrong way is a complaint.
 */
export function intoSendingWindow(instant: Date, timeZone: string): Date {
  if (isBusinessDay(instant, timeZone)) {
    const { hour } = partsIn(instant, timeZone);
    if (hour < WINDOW_START_HOUR) return atLocalHour(instant, timeZone, WINDOW_START_HOUR);
    if (hour < WINDOW_END_HOUR) return instant;
  }
  return atLocalHour(nextBusinessDay(instant, timeZone), timeZone, WINDOW_START_HOUR);
}

/** Advance `count` business days from an instant, ignoring the clock time. */
function addBusinessDays(instant: Date, timeZone: string, count: number): Date {
  let cursor = instant;
  for (let i = 0; i < count; i += 1) cursor = nextBusinessDay(cursor, timeZone);
  return cursor;
}

export type NextSendInput = {
  /** Day 0. The thing that started the rhythm; never itself an attempt. */
  readonly triggeredAt: Date;
  readonly rhythm: Rhythm;
  /** How many follow-ups have already been sent. 0 before the first. */
  readonly attemptsSoFar: number;
  /** IANA zone. Required — see the module note on why there is no default. */
  readonly timeZone: string;
  /**
   * `approval_requests.sla_due_at`, for `internal_approval`.
   *
   * When the next reminder would fall after it, there is no next reminder:
   * ADM-69 made the SLA the hard deadline that outranks the attempt count.
   */
  readonly slaDueAt?: Date | null;
};

/**
 * When the next follow-up is due, or `null` when there is not one.
 *
 * `null` means *stop*, and it is returned for every reason a rhythm ends:
 * attempts exhausted, or an SLA that has already passed. A caller that wants
 * to know *why* asks the record, not this function — the answer here is only
 * whether to schedule.
 */
export function nextSendAt(input: NextSendInput): Date | null {
  const { triggeredAt, rhythm, attemptsSoFar, timeZone, slaDueAt } = input;

  const days = RHYTHM_DAYS[rhythm];
  if (attemptsSoFar < 0 || attemptsSoFar >= days.length) return null;

  const offset = days[attemptsSoFar];
  if (offset === undefined) return null;

  const due = intoSendingWindow(addBusinessDays(triggeredAt, timeZone, offset), timeZone);

  // The SLA outranks the count, and is checked against the *scheduled* time
  // rather than now: a reminder that would land after the deadline is one
  // nobody should be sent, even if the deadline has not passed yet.
  if (slaDueAt && due.getTime() > slaDueAt.getTime()) return null;

  return due;
}
