/**
 * A wall-clock date and time in an IANA zone, as the UTC instant it names.
 *
 * Pure and dependency-free. `Intl` answers the reverse question (instant →
 * wall clock in a zone); the forward one is found by taking the wall clock
 * as if it were UTC, asking `Intl` what that instant reads as in the zone,
 * and correcting by the difference — twice, so a DST boundary between the
 * guess and the answer is absorbed. Returns null for a day, time or zone it
 * cannot read, rather than a guess at midnight somewhere.
 */
export function zonedDateTimeToIso(dayKey: string, hhmm: string, timeZone: string): string | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  const time = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!day || !time) return null;
  const [y, mo, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const [h, mi] = [Number(time[1]), Number(time[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }

  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const readBack = (instant: number): number => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
  };

  let instant = wallAsUtc - (readBack(wallAsUtc) - wallAsUtc);
  instant = instant - (readBack(instant) - wallAsUtc);
  const result = new Date(instant);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}
