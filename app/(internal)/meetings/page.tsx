import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, clockFor, getAgencyTimeZone } from '@/lib/admin/agency-clock';
import { readOperationalSettings, settingInstant, settingText } from '@/lib/admin/settings';
import { googleCalendarConfig } from '@/lib/scheduling/google';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  bookedOverlaps,
  groupByDay,
  MEETING_WINDOWS,
  meetingWindow,
  pickNewest,
  reminderState,
  timezonePair,
  whenOf,
} from '@/modules/crm/meetings-view';
import { listJobsForMeetings, listMeetings } from '@/modules/crm/queries';
import { MEETING_MODES, MEETING_STATUSES } from '@/modules/crm/schema';
import { Badge, Callout, EmptyState, IconClock, MonthGrid, PageHeader, StatusBadge, cx, humanize, monthGridDays } from '@/ui';

import { VerifyCalendarForm } from '../settings/forms';

export const metadata: Metadata = { title: 'Meetings' };

/**
 * A08 — the Scheduler calendar (Admin Panel Blueprint p6; Master Plan V3 §14).
 *
 * A day-grouped list over a window the reader chooses, not a calendar grid:
 * Scheduler §15 asks for the grid only "where configured". Since G-242 a
 * Google calendar may be (ADM-102); the callout says which state this
 * deployment is in. Every card shows the meeting's own zone first
 * ("Timezone always visible") and the agency's beside it when they differ.
 *
 * Read-only. Reschedule and cancel are on the meeting page as BLOCKED
 * controls naming the missing command — nothing here writes a row.
 * Gated on `lead.read`, the sales team's own capability; RLS admits every
 * internal role to the rows regardless of what this page decides to draw.
 */

const LIMIT = 200;
const MONTH = /^(\d{4})-(\d{2})$/;

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; status?: string; mode?: string; owner?: string; view?: string; month?: string }>;
}) {
  const context = await requireInternal('/meetings');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const params = await searchParams;
  const now = new Date();
  const agencyZone = await getAgencyTimeZone();
  const clock = await agencyClock();

  // SCR-010 — the month calendar. `?view=calendar&month=YYYY-MM` swaps the
  // day-grouped list for a grid over one agency-zone month; the same reader,
  // the same filters, a different window. Month boundaries are taken from
  // the agency clock's own "today" so the grid's days are agency days.
  const calendar = params.view === 'calendar';
  const todayKey = clock.dayKey(now);
  const monthMatch = MONTH.exec(params.month ?? '');
  const year = monthMatch ? Number(monthMatch[1]) : Number(todayKey.slice(0, 4));
  const month = monthMatch && Number(monthMatch[2]) >= 1 && Number(monthMatch[2]) <= 12 ? Number(monthMatch[2]) : Number(todayKey.slice(5, 7));
  // The zone's offset at "today": the difference between the UTC instant the
  // agency day starts and midnight UTC of the same calendar date.
  const zoneOffsetMs = clock.today(now).from.getTime() - Date.parse(`${todayKey}T00:00:00Z`);
  const monthStart = new Date(Date.UTC(year, month - 1, 1) + zoneOffsetMs);
  const monthEnd = new Date(Date.UTC(year, month, 1) + zoneOffsetMs);
  const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
  const prevMonth = month === 1 ? monthKey(year - 1, 12) : monthKey(year, month - 1);
  const nextMonth = month === 12 ? monthKey(year + 1, 1) : monthKey(year, month + 1);

  const window = calendar
    ? { key: 'month' as const, from: monthStart, to: monthEnd, label: `${monthKey(year, month)} (${agencyZone})`, chip: 'Month' }
    : meetingWindow(params.window, now, agencyZone);
  // Only a filter the schema names is applied; a stranger is ignored, not
  // passed to the database as a string it would refuse.
  const status = (MEETING_STATUSES as readonly string[]).includes(params.status ?? '') ? params.status : undefined;
  const mode = (MEETING_MODES as readonly string[]).includes(params.mode ?? '') ? params.mode : undefined;
  // Blueprint A08: "Owner/mode/status filters." A meeting has no owner of its
  // own; its lead's assignee is the nearest thing, and 'mine' is the reader.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const owner = params.owner === 'mine' ? context.userId : UUID.test(params.owner ?? '') ? params.owner : undefined;

  const rows = await listMeetings({ from: window.from, to: window.to, status, mode, owner, newestFirst: window.key === 'past', limit: LIMIT });
  const jobs = await listJobsForMeetings(rows.map((r) => r.id));
  const byMeeting = new Map<string, typeof jobs>();
  for (const j of jobs) if (j.kind === 'meeting.reminder') byMeeting.set(j.meetingId, [...(byMeeting.get(j.meetingId) ?? []), j]);
  const owners = [...new Set(rows.map((r) => r.lead?.assigned_to).filter((id): id is string => Boolean(id)))];

  const googleCalendar = googleCalendarConfig();
  const settings = await readOperationalSettings();
  const calendarVerifiedAt = settingInstant(settings, 'calendar_verified_at');
  const calendarVerified = settingText(settings, 'calendar_verified_calendar');
  const conflicts = bookedOverlaps(rows);
  const groups = groupByDay(rows, (iso) => clock.dayKey(iso));

  const href = (over: Partial<{ window: string; status: string; mode: string; owner: string; view: string; month: string }>) => {
    const q = new URLSearchParams();
    const next = {
      window: calendar ? '' : window.key,
      status,
      mode,
      owner: params.owner === 'mine' ? 'mine' : owner,
      view: calendar ? 'calendar' : '',
      month: calendar && monthMatch ? monthKey(year, month) : '',
      ...over,
    };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    const s = q.toString();
    return `/meetings${s ? `?${s}` : ''}`;
  };

  // The grid's cells: one chip per meeting on its agency day.
  const cells = new Map<string, React.ReactNode>();
  if (calendar) {
    for (const group of groups) {
      if (!group.day) continue;
      cells.set(
        group.day,
        group.rows.map((m) => {
          const when = whenOf(m);
          return (
            <Link
              key={m.id}
              href={`/meetings/${m.id}`}
              className={cx(
                'block truncate rounded px-1 py-0.5 text-[11px] leading-tight hover:bg-surface-hover',
                m.status === 'cancelled' ? 'text-faint line-through' : when.kind === 'confirmed' ? 'bg-brand-soft text-brand' : 'bg-surface-sunken text-muted',
              )}
              title={`${m.contact?.full_name ?? m.lead?.title ?? 'Unnamed lead'} · ${humanize(m.status)}`}
            >
              {when.kind === 'unscheduled' ? '' : `${clock.clock(when.start)} `}
              {m.contact?.full_name ?? m.lead?.title ?? 'Unnamed lead'}
            </Link>
          );
        }),
      );
    }
  }

  const chip = (active: boolean) =>
    cx(
      'rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors',
      active ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-hover hover:text-foreground',
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Meetings"
        description={`Every meeting the system knows about, in the window you choose. Times are shown in each meeting's own zone. ${calendar ? `Slots are read from google:${calendar.calendarId} and booked as calendar events from a meeting's page.` : 'No calendar credential is configured: a booking is a row written by a person, and nothing is offered.'}`}
      />

      {/* Blueprint §8: a BLOCKED state names the blocker and its owner. G-242: three states, said. */}
      {googleCalendar ? (
        <Callout tone={calendarVerifiedAt ? 'success' : 'info'} title={calendarVerifiedAt ? `Calendar: google:${googleCalendar.calendarId} — verified` : `Calendar: google:${googleCalendar.calendarId} — configured, not yet verified`}>
          Availability is read from this calendar and nothing is invented (G-226). On a meeting&rsquo;s page,
          <em> Propose a time</em> offers what the calendar has free and <em>Book</em> re-checks it, creates the
          Google event with its Meet link and writes the row (G-243). The client is told by you.
          {can(context.role, 'organization.settings') ? (
            <div className="mt-2">
              <VerifyCalendarForm lastVerifiedAt={calendarVerifiedAt} calendar={calendarVerified} />
            </div>
          ) : null}
        </Callout>
      ) : (
        <Callout tone="warning" title="Nothing can be proposed or booked from here yet">
          No calendar credential is in the deployment environment (BLK-005), so availability answers{' '}
          <em>unconfigured</em> and the system refuses to invent a slot. ADM-102 chose Google Calendar + Meet;
          the adapter registers the moment the owner places the service-account values (Configuration → Calendar).
        </Callout>
      )}

      <nav aria-label="Window and filters" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-subtle bg-surface px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-faint">View</span>
          <Link href={href({ view: '', month: '' })} className={chip(!calendar)} aria-current={!calendar ? 'true' : undefined}>
            List
          </Link>
          <Link href={href({ view: 'calendar', window: '' })} className={chip(calendar)} aria-current={calendar ? 'true' : undefined}>
            Calendar
          </Link>
        </div>
        {!calendar ? (
          <div className="flex items-center gap-1">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Window</span>
            {MEETING_WINDOWS.map((w) => (
              <Link key={w} href={href({ window: w })} className={chip(window.key === w)} aria-current={window.key === w ? 'true' : undefined}>
                {meetingWindow(w, now, agencyZone).chip}
              </Link>
            ))}
            <span className="ml-1 font-mono text-[10.5px] text-faint">agency days · {agencyZone}</span>
          </div>
        ) : null}
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Lead owner</span>
          <Link href={href({ owner: '' })} className={chip(!owner)}>Anyone</Link>
          <Link href={href({ owner: 'mine' })} className={chip(params.owner === 'mine')}>Mine</Link>
          {owners.filter((id) => id !== context.userId).map((id) => (
            <Link key={id} href={href({ owner: id })} className={cx(chip(owner === id), 'font-mono')} title={id}>
              {id.slice(0, 8)}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Status</span>
          <Link href={href({ status: '' })} className={chip(!status)}>Any</Link>
          {MEETING_STATUSES.map((s) => (
            <Link key={s} href={href({ status: s })} className={chip(status === s)}>{humanize(s)}</Link>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Mode</span>
          <Link href={href({ mode: '' })} className={chip(!mode)}>Any</Link>
          {MEETING_MODES.map((m) => (
            <Link key={m} href={href({ mode: m })} className={chip(mode === m)}>{humanize(m)}</Link>
          ))}
        </div>
      </nav>

      {calendar ? (
        <>
          <MonthGrid
            days={monthGridDays(year, month, todayKey)}
            cells={cells}
            title={`${new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })} · ${agencyZone}`}
            prevHref={href({ view: 'calendar', month: prevMonth, window: '' })}
            nextHref={href({ view: 'calendar', month: nextMonth, window: '' })}
          />
          <p className="px-1 text-[12px] text-faint">
            {rows.length} meeting{rows.length === 1 ? '' : 's'} in this month{status || mode || owner ? ' matching the filters' : ''}
            {rows.length >= LIMIT ? ` — bounded at ${LIMIT}; narrow the filters to see the rest` : ''}. Agreed times are highlighted; requested-but-unagreed ones are muted; a meeting with no time recorded is not on the grid.
          </p>
        </>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<IconClock size={20} />}
          title={`No meetings in ${window.label}`}
          description={
            status || mode || owner
              ? 'Nothing matches these filters in this window. That is a count of rows, not a guess.'
              : 'No meeting has been requested or booked for this window. Nothing is estimated here; a meeting appears when one is recorded.'
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {rows.length >= LIMIT ? (
            <Callout tone="info">
              Showing {LIMIT} of the meetings in {window.label}: the {window.key === 'past' ? 'latest' : 'earliest'} agreed times first, then requested-but-unagreed ones — so the rows not shown are the request-only ones. Narrow the window or the filters to see them; the list is bounded on purpose.
            </Callout>
          ) : null}

          {groups.map((group) => (
            <section key={group.day ?? 'unscheduled'} className="flex flex-col gap-2">
              <h2 className="px-1 text-[12.5px] font-semibold text-muted">
                {group.day ? `${clock.weekday(group.rows[0]!.confirmed_start_at ?? group.rows[0]!.requested_start_at ?? now)} · ${clock.day(group.rows[0]!.confirmed_start_at ?? group.rows[0]!.requested_start_at ?? now)}` : 'No time recorded'}
                <span className="ml-2 font-normal text-faint">agency day, {agencyZone}</span>
              </h2>
              <ol className="flex flex-col gap-2">
                {group.rows.map((m) => {
                  const when = whenOf(m);
                  const zones = timezonePair(m.timezone, agencyZone);
                  const local = clockFor(zones.primary);
                  const agency = zones.secondary ? clockFor(zones.secondary) : null;
                  const overlap = conflicts.get(m.id);
                  const reminder = reminderState(pickNewest(byMeeting.get(m.id) ?? []), m);
                  return (
                    <li key={m.id}>
                      <Link
                        href={`/meetings/${m.id}`}
                        className="flex flex-col gap-1.5 rounded-lg border border-subtle bg-surface p-3 transition-colors hover:border-line-strong hover:bg-surface-hover"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                            {m.contact?.full_name ?? m.lead?.title ?? 'Unnamed lead'}
                            {m.contact?.full_name && m.lead?.title ? <span className="ml-1.5 text-muted">· {m.lead.title}</span> : null}
                          </span>
                          <StatusBadge status={m.status} />
                          <Badge tone="neutral">{humanize(m.booked_mode ?? m.requested_mode)}{m.booked_mode ? '' : ' (requested)'}</Badge>
                          {overlap ? (
                            <Badge tone="warning" dot>
                              Overlaps {overlap.length === 1 ? 'another booking' : `${overlap.length} bookings`}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12.5px] text-muted">
                          {when.kind === 'unscheduled' ? (
                            <span>No time requested or agreed</span>
                          ) : (
                            <>
                              <span className="tabular text-foreground">
                                {local.dateTime(when.start)}
                                {when.end ? `–${local.clock(when.end)}` : ''}
                              </span>
                              <span className="font-mono text-[11px]">{zones.primary}</span>
                              {zones.unrecognised !== null ? (
                                <Badge tone="danger" dot>zone “{zones.unrecognised}” not recognised — shown in {zones.primary}</Badge>
                              ) : null}
                              {agency ? (
                                <span className="text-faint">
                                  = {agency.dateTime(when.start)} <span className="font-mono text-[11px]">{zones.secondary}</span>
                                </span>
                              ) : null}
                              <span className="text-faint">{when.kind === 'confirmed' ? 'agreed' : 'requested, not agreed'}</span>
                            </>
                          )}
                        </div>
                        <p className={cx('text-[12px]', reminder.tone === 'warning' ? 'text-warning' : 'text-faint')}>{reminder.text}</p>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}

          <p className="px-1 text-[12px] text-faint">
            Overlap badges compare AgencyOS bookings with each other only — no provider calendar is read, and
            nobody&rsquo;s private calendar is consulted.
          </p>
        </div>
      )}
    </div>
  );
}
