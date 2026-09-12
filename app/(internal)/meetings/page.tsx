import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, clockFor, getAgencyTimeZone } from '@/lib/admin/agency-clock';
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
import { Badge, Callout, EmptyState, IconClock, PageHeader, StatusBadge, cx, humanize } from '@/ui';

export const metadata: Metadata = { title: 'Meetings' };

/**
 * A08 — the Scheduler calendar (Admin Panel Blueprint p6; Master Plan V3 §14).
 *
 * A day-grouped list over a window the reader chooses, not a calendar grid:
 * Scheduler §15 asks for the grid only "where configured", and no calendar
 * provider is (BLK-005). Every card shows the meeting's own zone first
 * ("Timezone always visible") and the agency's beside it when they differ.
 *
 * Read-only. Reschedule and cancel are on the meeting page as BLOCKED
 * controls naming the missing command — nothing here writes a row.
 * Gated on `lead.read`, the sales team's own capability; RLS admits every
 * internal role to the rows regardless of what this page decides to draw.
 */

const LIMIT = 200;

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; status?: string; mode?: string; owner?: string }>;
}) {
  const context = await requireInternal('/meetings');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const params = await searchParams;
  const now = new Date();
  const agencyZone = await getAgencyTimeZone();
  const window = meetingWindow(params.window, now, agencyZone);
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

  const clock = await agencyClock();
  const conflicts = bookedOverlaps(rows);
  const groups = groupByDay(rows, (iso) => clock.dayKey(iso));

  const href = (over: Partial<{ window: string; status: string; mode: string; owner: string }>) => {
    const q = new URLSearchParams();
    const next = { window: window.key, status, mode, owner: params.owner === 'mine' ? 'mine' : owner, ...over };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    const s = q.toString();
    return `/meetings${s ? `?${s}` : ''}`;
  };

  const chip = (active: boolean) =>
    cx(
      'rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors',
      active ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-hover hover:text-foreground',
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Meetings"
        description="Every meeting the system knows about, in the window you choose. Times are shown in each meeting's own zone. A booking here is a row, not a calendar event: no provider is configured."
      />

      {/* Blueprint §8: a BLOCKED state names the blocker and its owner. */}
      <Callout tone="warning" title="Nothing can be proposed or booked from here yet">
        No calendar provider is configured (BLK-005), so availability answers <em>unconfigured</em> and
        the system refuses to invent a slot. Meetings appear here when they are recorded; choosing a
        provider is the owner&rsquo;s decision.
      </Callout>

      <nav aria-label="Window and filters" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-subtle bg-surface px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Window</span>
          {MEETING_WINDOWS.map((w) => (
            <Link key={w} href={href({ window: w })} className={chip(window.key === w)} aria-current={window.key === w ? 'true' : undefined}>
              {meetingWindow(w, now, agencyZone).chip}
            </Link>
          ))}
          <span className="ml-1 font-mono text-[10.5px] text-faint">agency days · {agencyZone}</span>
        </div>
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

      {rows.length === 0 ? (
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
