import { z } from 'zod';

/**
 * SCR-022 "Sync supported calendars" (migration 20261001120000). Without
 * OAuth, the one honest sync is a subscribable ICS feed keyed by a random
 * token per person per project. Google, Apple and Outlook all subscribe
 * to a URL; the feed is the project's dated tasks, milestones and meetings.
 */
export const createCalendarFeedSchema = z.object({ projectId: z.uuid() });
export const revokeCalendarFeedSchema = z.object({ feedId: z.uuid() });

export type CreateCalendarFeedInput = z.input<typeof createCalendarFeedSchema>;
export type RevokeCalendarFeedInput = z.input<typeof revokeCalendarFeedSchema>;

/** One entry the feed renders. `date` is a day key (all-day) unless `startAt` is set. */
export type CalendarFeedEntry = {
  uid: string;
  summary: string;
  date: string;
  startAt: string | null;
  description: string | null;
  url: string | null;
};

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(dayKey: string): string {
  return dayKey.replace(/-/g, '');
}

function icsDateTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Fold lines at 75 octets as RFC 5545 asks. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

/**
 * Pure: the ICS text for a project. Deterministic for the same entries
 * and `stamp`, so a subscriber sees a stable file; every event carries
 * the entry's own uid so an updated date replaces rather than duplicates.
 */
export function renderCalendarFeed(input: { calendarName: string; entries: readonly CalendarFeedEntry[]; stamp: string }): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AgencyOS//Project calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(input.calendarName)}`];
  const stamp = icsDateTime(input.stamp);
  for (const e of input.entries) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEscape(e.summary)}`);
    if (e.startAt) {
      lines.push(`DTSTART:${icsDateTime(e.startAt)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`);
    }
    if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
