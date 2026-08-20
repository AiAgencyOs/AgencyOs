/**
 * Formatting a moment in a named zone. No request context, no database, no
 * `server-only` — so it is directly unit-testable and a script can use it.
 *
 * Same split as `env-schema.ts` against `env.ts`, and for the same reason the
 * neighbouring `timezone.ts` gives: the rule is worth testing without dragging
 * a Next request into the test.
 *
 * Which zone to use is the other half, and it needs the organisation. That
 * lives in `agency-clock.ts`.
 */

/**
 * The formatters the screens use, bound to one zone.
 *
 * Built as a set rather than one at a time so a page cannot accidentally
 * format its dates in the agency's zone and its times in the runtime's — which
 * is the shape the original bug took.
 */
export type AgencyClock = {
  timeZone: string;
  /** 19 Aug 2026 */
  date: (value: string | Date) => string;
  /** 19 Aug 2026, 9:09 pm */
  dateTime: (value: string | Date) => string;
  /** 9:09 pm — the time inside a chat bubble */
  clock: (value: string | Date) => string;
  /** Tuesday, 19 August — a day divider */
  day: (value: string | Date) => string;
  /** Tue — the weekday column in a chat list */
  weekday: (value: string | Date) => string;
  /**
   * Which calendar day this instant falls on **in the agency's zone**, as
   * `YYYY-MM-DD`.
   *
   * The reason day grouping needs its own function rather than a `Date`
   * comparison: `toDateString()` answers in the runtime's zone, so two messages
   * either side of local midnight are grouped by UTC's idea of the day.
   */
  dayKey: (value: string | Date) => string;
};

export function clockFor(timeZone: string): AgencyClock {
  const at = (value: string | Date) => (value instanceof Date ? value : new Date(value));

  const date = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone });
  const dateTime = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const clock = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  const weekday = new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone });
  const day = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  });
  // en-CA gives ISO order (2026-08-19), which sorts and compares as a string.
  const key = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  });

  return {
    timeZone,
    date: (v) => date.format(at(v)),
    dateTime: (v) => dateTime.format(at(v)),
    clock: (v) => clock.format(at(v)),
    day: (v) => day.format(at(v)),
    weekday: (v) => weekday.format(at(v)),
    dayKey: (v) => key.format(at(v)),
  };
}
