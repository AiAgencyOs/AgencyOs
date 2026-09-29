/**
 * A five-field cron expression, parsed and stepped — SCR-048's suite
 * schedules. Pure, so the test pins it and the tick and the form agree.
 *
 *   minute hour day-of-month month day-of-week
 *
 * Each field: `*`, a number, `a-b`, `a,b,c`, or any of those with `/n`.
 * Day-of-week 0–7 (0 and 7 are Sunday). Names are not accepted — a
 * schedule is typed once and read by a machine; "mon" is a spelling
 * question the form does not need.
 *
 * The next occurrence is computed in a named IANA zone (the agency's) by
 * walking minutes forward from `after`, at most 366 days, so a schedule
 * that can never fire (31 February) answers null rather than looping.
 */

export type CronFields = { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number> };

function parseField(raw: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range?.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b) || a > b) return null;
      lo = a;
      hi = b;
    } else {
      const n = Number(range);
      if (!Number.isInteger(n)) return null;
      lo = n;
      hi = stepRaw === undefined ? n : max;
    }
    if (lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const day = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const weekdayRaw = parseField(parts[4]!, 0, 7);
  if (!minute || !hour || !day || !month || !weekdayRaw) return null;
  const weekday = new Set([...weekdayRaw].map((d) => (d === 7 ? 0 : d)));
  return { minute, hour, day, month, weekday };
}

type Local = { minute: number; hour: number; day: number; month: number; weekday: number };

function localParts(at: Date, timeZone: string): Local {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(get('hour')) % 24;
  return { minute: Number(get('minute')), hour, day: Number(get('day')), month: Number(get('month')), weekday: weekdays[get('weekday')] ?? 0 };
}

/**
 * The first moment strictly after `after` that the expression names, in
 * `timeZone`, or null when none falls within 366 days. Standard cron
 * semantics for day-of-month and day-of-week: when both are restricted,
 * either matching is enough.
 */
export function nextCronOccurrence(expression: string, after: Date, timeZone: string): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;
  const dayRestricted = fields.day.size < 31;
  const weekdayRestricted = fields.weekday.size < 7;
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const limit = start.getTime() + 366 * 86_400_000;
  for (let t = start.getTime(); t <= limit; t += 60_000) {
    const at = new Date(t);
    const l = localParts(at, timeZone);
    if (!fields.minute.has(l.minute) || !fields.hour.has(l.hour) || !fields.month.has(l.month)) continue;
    const dayOk = fields.day.has(l.day);
    const weekdayOk = fields.weekday.has(l.weekday);
    const matches = dayRestricted && weekdayRestricted ? dayOk || weekdayOk : dayRestricted ? dayOk : weekdayRestricted ? weekdayOk : true;
    if (matches) return at;
  }
  return null;
}

/** "Every day at 02:00", "Mondays at 09:30" — for the schedule list; falls back to the expression. */
export function describeCron(expression: string): string {
  const f = parseCron(expression);
  if (!f) return expression;
  const parts = expression.trim().split(/\s+/);
  const time = f.minute.size === 1 && f.hour.size === 1 ? `at ${String([...f.hour][0]).padStart(2, '0')}:${String([...f.minute][0]).padStart(2, '0')}` : `minute ${parts[0]} hour ${parts[1]}`;
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (f.weekday.size < 7 && f.day.size === 31) return `${[...f.weekday].sort().map((d) => names[d]).join(', ')} ${time}`;
  if (f.day.size < 31 && f.weekday.size === 7) return `day ${[...f.day].sort((a, b) => a - b).join(', ')} of the month ${time}`;
  return `every day ${time}`;
}
