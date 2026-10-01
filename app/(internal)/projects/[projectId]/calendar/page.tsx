import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock, getAgencyTimeZone } from '@/lib/admin/agency-clock';
import { listClientLeads } from '@/lib/admin/client-leads';
import { readClientName } from '@/lib/admin/clients';
import { isDayKey, shiftDay, weekOf, WEEKDAY_LABELS } from '@/lib/admin/month-grid';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { clientEnv } from '@/lib/env';
import { readMyCalendarFeed } from '@/modules/projects/calendar-feed-queries';
import { describeScheduleMove, listScheduleChanges, SCHEDULE_KIND_LABEL, scheduleChangeHref } from '@/modules/projects/schedule-changes-queries';
import { listProjectMeetings } from '@/modules/projects/calendar-queries';
import { getProject, listDevelopmentBreakdown, listPaymentPlan } from '@/modules/projects/queries';
import {
  Badge,
  Card,
  CardHeader,
  cx,
  EmptyState,
  humanize,
  IconCalendar,
  IconCheck,
  IconClock,
  IconFlag,
  IconGrid,
  IconPlus,
  MonthGrid,
  PermissionDenied,
  QuickActions,
  StatusBadge,
  ViewAll,
  type CalendarEntry as GridEntry,
} from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

import { AddMilestoneOnDayForm } from './add-milestone-form';
import { AddTaskOnDayForm } from './add-task-form';
import { CalendarFeedPanel } from './calendar-feed-panel';
import { ProposeMeetingOnDayForm } from './propose-meeting-form';

export const metadata: Metadata = { title: 'Calendar' };

const VIEWS = ['month', 'week', 'day', 'list'] as const;
type View = (typeof VIEWS)[number];
const KINDS = ['task', 'milestone', 'meeting', 'deadline'] as const;
type Kind = (typeof KINDS)[number];

type CalendarEntry = { id: string; date: string; label: string; kind: Kind; status: string; overdue: boolean; time: string | null; href: string };

function viewOf(value: string | undefined): View {
  return (VIEWS as readonly string[]).includes(value ?? '') ? (value as View) : 'month';
}

function kindsOf(value: string | undefined): Set<Kind> {
  const picked = (value ?? '').split(',').filter((k): k is Kind => (KINDS as readonly string[]).includes(k));
  return new Set(picked.length > 0 ? picked : KINDS);
}

/**
 * `YYYY-MM-DD` → "Weekday, D Month", with no timezone conversion at all.
 *
 * `date` here has no time component to begin with (`projects.tasks.due_on`
 * and `.milestones.due_on` are both plain SQL `date` columns), so appending
 * a fake midnight and letting `Intl.DateTimeFormat` reinterpret it in the
 * agency's configured timezone could shift the displayed day by one
 * whenever the server process's local zone and the agency's disagree.
 */
function formatDayKey(dayKey: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-IN', opts);
}

/**
 * SCR-022 — Project Calendar, laid out as the reference: the month grid
 * with the agenda under it, and a rail of upcoming dates, the milestones,
 * and quick actions. Tasks and milestones come from readers this project
 * page already has (listDevelopmentBreakdown, listPaymentPlan) — no new
 * query. Meetings are deliberately excluded: `crm.meetings` links to a
 * lead, never a project, so a per-project meeting calendar would be
 * inventing a relationship the schema does not have.
 *
 * The month grid reuses the same `entries` the agenda and the rail use —
 * one derivation, three views, so they can never show different dates.
 */
export default async function ProjectCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ month?: string; view?: string; date?: string; types?: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/calendar`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const [{ tasks, modules }, milestones, clientName, meetings, clientLeads, agencyZone, feed, scheduleChanges] = await Promise.all([
    listDevelopmentBreakdown(projectId, { excludeCancelled: true }),
    listPaymentPlan(projectId),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    listProjectMeetings(projectId),
    // SCR-022 — "Propose a meeting on this day" picks one of the client's leads.
    project.client_account_id ? listClientLeads(project.client_account_id) : Promise.resolve([]),
    getAgencyTimeZone(),
    // SCR-022 — "Sync supported calendars": the caller's own ICS feed, if one exists.
    readMyCalendarFeed(projectId),
    // SCR-022 "Changes must preserve history": every date that moved on this project, from the audit trail.
    listScheduleChanges({ projectId, limit: 8 }),
  ]);
  const mayProposeMeeting = can(context, 'lead.write');
  // SCR-022 — "create a milestone on this day": an unpriced one, through milestone.write.
  const mayAddMilestone = can(context, 'milestone.write');
  const leadOptions = clientLeads.map((l) => ({ id: l.id, title: l.title }));

  // SCR-022: `?view=month|week|day|list`, `?date=` anchors week/day, and
  // `?types=` toggles the kinds shown. Meetings are the ones booked on the
  // opportunity this project was won from (`listProjectMeetings`) — the one
  // trace the schema carries; nothing is inferred through the client.
  const { month: requestedMonth, view: rawView, date: rawDate, types } = await searchParams;
  const today = clock.dayKey(new Date());
  const view = viewOf(rawView);
  const kinds = kindsOf(types);
  const anchor = isDayKey(rawDate) ? rawDate : today;
  const mayWrite = can(context, 'task.write');
  const moduleOptions = modules.map((m) => ({ id: m.id, name: m.name }));
  const entries: CalendarEntry[] = [];

  if (kinds.has('task')) {
    for (const t of tasks) {
      if (!t.dueOn || t.status === 'done') continue;
      entries.push({ id: `task-${t.id}`, date: t.dueOn, label: t.title, kind: 'task', status: t.status, overdue: t.dueOn < today, time: null, href: `/projects/${projectId}/development/tasks/${t.id}` });
    }
  }
  if (kinds.has('milestone')) {
    for (const m of milestones) {
      if (!m.due_on || m.status === 'met') continue;
      entries.push({ id: `milestone-${m.id}`, date: m.due_on, label: m.name, kind: 'milestone', status: m.status, overdue: m.due_on < today, time: null, href: `/projects/${projectId}/milestones?milestone=${m.id}` });
    }
  }
  // SCR-022 "deadline": the project's own due date, the one deadline that is not a task or a milestone.
  if (kinds.has('deadline') && project.ends_on && project.status !== 'completed' && project.status !== 'cancelled') {
    entries.push({ id: `deadline-${projectId}`, date: project.ends_on, label: `${project.name} is due`, kind: 'deadline', status: project.status, overdue: project.ends_on < today, time: null, href: `/projects/${projectId}` });
  }
  if (kinds.has('meeting')) {
    for (const m of meetings) {
      if (!m.startAt) continue;
      entries.push({
        id: `meeting-${m.id}`,
        date: clock.dayKey(m.startAt),
        label: `${humanize(m.mode ?? 'meeting')}${m.outcome ? ` · ${humanize(m.outcome)}` : ''}`,
        kind: 'meeting',
        status: m.status,
        overdue: false,
        time: clock.clock(m.startAt),
        href: `/meetings/${m.id}`,
      });
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));

  const byDate = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }

  const month = requestedMonth && /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : anchor.slice(0, 7);
  const typesParam = kinds.size === KINDS.length ? '' : `&types=${[...kinds].join(',')}`;
  const link = (v: View, date: string, k?: Set<Kind>) => {
    const t = k ? (k.size === KINDS.length ? '' : `&types=${[...k].join(',')}`) : typesParam;
    return `/projects/${projectId}/calendar?view=${v}&date=${date}${t}`;
  };
  const toggleKind = (k: Kind): Set<Kind> => {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    // Turning off the last one would show nothing; treat it as "all".
    return next.size === 0 ? new Set(KINDS) : next;
  };
  const weekDays = weekOf(anchor);
  const dayEntries = byDate.get(anchor) ?? [];

  const gridEntriesByDate: Record<string, GridEntry[]> = {};
  for (const [date, dayEntries] of byDate) {
    gridEntriesByDate[date] = dayEntries.map((e) => ({
      label: e.time ? `${e.time} ${e.label}` : e.label,
      tone: e.overdue || e.kind === 'deadline' ? 'danger' : e.kind === 'milestone' ? 'brand' : e.kind === 'meeting' ? 'accent' : 'info',
      href: e.href,
    }));
  }

  const upcoming = entries.filter((e) => e.date >= today).slice(0, 6);
  const overdueCount = entries.filter((e) => e.overdue).length;

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Link href={link(view, today)} className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover">Today</Link>
      <div className="inline-flex overflow-hidden rounded-lg border border-line text-[13px] font-medium" role="group" aria-label="Calendar view">
        {VIEWS.map((v) => (
          <Link
            key={v}
            href={link(v, anchor)}
            aria-current={v === view ? 'true' : undefined}
            className={cx('px-3.5 py-2 transition-colors', v === view ? 'bg-brand text-brand-fg' : 'bg-surface text-muted hover:bg-surface-hover')}
          >
            {humanize(v)}
          </Link>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={can(context, 'project.write')} />

      <ProjectSubNav projectId={projectId} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {view !== 'month' ? toolbar : null}
          {view === 'week' ? (
            <Card>
              <CardHeader
                title={`Week of ${formatDayKey(weekDays[0] ?? anchor, { day: 'numeric', month: 'long' })}`}
                description="Seven days, Monday first. Add a task straight onto a day."
                actions={
                  <span className="flex items-center gap-1 text-[13px]">
                    <Link href={link('week', shiftDay(anchor, -7))} className="rounded-md px-2 py-1 text-muted hover:bg-surface-hover">← Previous</Link>
                    <Link href={link('week', today)} className="rounded-md px-2 py-1 text-muted hover:bg-surface-hover">This week</Link>
                    <Link href={link('week', shiftDay(anchor, 7))} className="rounded-md px-2 py-1 text-muted hover:bg-surface-hover">Next →</Link>
                  </span>
                }
              />
              <div className="grid grid-cols-1 gap-2 p-3 sm:p-4 md:grid-cols-7">
                {weekDays.map((key, i) => (
                  <div key={key} className={cx('flex min-h-32 flex-col rounded-lg border border-line bg-surface p-2', key === today && 'ring-2 ring-brand/40')}>
                    <div className="flex items-center justify-between">
                      <Link href={link('day', key)} className={cx('text-xs font-semibold', key === today ? 'text-brand' : 'text-muted')}>
                        {WEEKDAY_LABELS[i]} {key.slice(8)}
                      </Link>
                      <span className="flex items-center gap-1.5">
                        {mayWrite ? <AddTaskOnDayForm projectId={projectId} dueOn={key} modules={moduleOptions} compact /> : null}
                        {mayAddMilestone ? <AddMilestoneOnDayForm projectId={projectId} dueOn={key} compact /> : null}
                        {mayProposeMeeting ? <ProposeMeetingOnDayForm projectId={projectId} date={key} leads={leadOptions} agencyZone={agencyZone} compact /> : null}
                      </span>
                    </div>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {(byDate.get(key) ?? []).map((e) => (
                        <li key={`${e.id}-${key}`}>
                          <Link href={e.href} className={cx('block w-full truncate rounded px-1.5 py-0.5 text-xs', e.overdue || e.kind === 'deadline' ? 'bg-danger-soft text-danger' : e.kind === 'milestone' ? 'bg-brand-soft text-brand' : e.kind === 'meeting' ? 'bg-accent-soft text-accent' : 'bg-info-soft text-info')}>
                            {e.time ? <span className="mr-1 tabular opacity-80">{e.time}</span> : null}
                            {e.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {view === 'day' ? (
            <Card>
              <CardHeader
                title={`${formatDayKey(anchor)}${anchor === today ? ' — today' : anchor < today ? ' — past' : ''}`}
                description="Everything due or booked on this day."
                actions={
                  <span className="flex items-center gap-1 text-[13px]">
                    <Link href={link('day', shiftDay(anchor, -1))} className="rounded-md px-2 py-1 text-muted hover:bg-surface-hover">← Previous</Link>
                    <Link href={link('day', today)} className="rounded-md px-2 py-1 text-muted hover:bg-surface-hover">Today</Link>
                    <Link href={link('day', shiftDay(anchor, 1))} className="rounded-md px-2 py-1 text-muted hover:bg-surface-hover">Next →</Link>
                  </span>
                }
              />
              <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                {dayEntries.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {dayEntries.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                        <Badge tone={e.kind === 'milestone' ? 'brand' : e.kind === 'meeting' ? 'accent' : 'info'}>{e.kind}</Badge>
                        {e.time ? <span className="tabular text-xs text-muted">{e.time}</span> : null}
                        <Link href={e.href} className="hover:text-brand">{e.label}</Link>
                        <StatusBadge status={e.status} dot={false} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-muted">Nothing due or booked on this day.</p>
                )}
                {mayWrite || mayProposeMeeting || mayAddMilestone ? (
                  <div className="flex flex-wrap items-start gap-2 border-t border-line pt-3">
                    {mayWrite ? <AddTaskOnDayForm projectId={projectId} dueOn={anchor} modules={moduleOptions} /> : null}
                    {mayAddMilestone ? <AddMilestoneOnDayForm projectId={projectId} dueOn={anchor} /> : null}
                    {mayProposeMeeting ? <ProposeMeetingOnDayForm projectId={projectId} date={anchor} leads={leadOptions} agencyZone={agencyZone} /> : null}
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          {view === 'month' ? (
          <Card>
            <CardHeader
              title="Project Calendar"
              description="View all project tasks, milestones and important dates in one place."
              actions={
                <span className="flex items-center gap-2 text-xs text-muted">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-info" /> Task</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand" /> Milestone</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-danger" /> Deadline</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-danger" /> Overdue</span>
                </span>
              }
            />
            <div className="flex flex-col gap-3 p-3 sm:p-4">
              {toolbar}
              <MonthGrid month={month} entriesByDate={gridEntriesByDate} todayKey={today} monthHref={(m) => `/projects/${projectId}/calendar?month=${m}${typesParam}`} />
              {mayWrite ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[13px] text-muted">
                  <span>Create a task on a day:</span>
                  <AddTaskOnDayForm projectId={projectId} dueOn={anchor} modules={moduleOptions} />
                  {mayAddMilestone ? (
                    <>
                      <span>· or a milestone:</span>
                      <AddMilestoneOnDayForm projectId={projectId} dueOn={anchor} />
                    </>
                  ) : null}
                  {mayProposeMeeting ? (
                    <>
                      <span>· or propose a meeting:</span>
                      <ProposeMeetingOnDayForm projectId={projectId} date={anchor} leads={leadOptions} agencyZone={agencyZone} />
                    </>
                  ) : null}
                  <span className="text-xs">(pick the day in the week or day view for another date)</span>
                </div>
              ) : null}
            </div>
          </Card>
          ) : null}

          {(view === 'month' || view === 'list') && byDate.size > 0 ? (
            <Card>
              <CardHeader title="Agenda" description={`${entries.length} dated item${entries.length === 1 ? '' : 's'}${overdueCount > 0 ? ` · ${overdueCount} overdue` : ''}.`} />
              <ul className="divide-y divide-line">
                {[...byDate.entries()].map(([date, dayEntries]) => (
                  <li key={date} className="flex gap-4 px-4 py-3 sm:px-5">
                    <span className={cx('flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg text-center', date < today ? 'bg-danger-soft text-danger' : date === today ? 'bg-brand-soft text-brand' : 'bg-surface-sunken text-muted')}>
                      <span className="text-[10px] font-semibold uppercase leading-none">{formatDayKey(date, { month: 'short' })}</span>
                      <span className="tabular text-lg font-semibold leading-tight">{date.slice(8, 10)}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className={cx('text-[13px] font-medium', date < today ? 'text-danger' : 'text-foreground')}>
                          <Link href={link('day', date)} className="hover:underline">{formatDayKey(date)}</Link>
                          {date < today ? ' — overdue' : date === today ? ' — today' : ''}
                        </p>
                        <span className="flex items-center gap-1.5">
                          {mayWrite ? <AddTaskOnDayForm projectId={projectId} dueOn={date} modules={moduleOptions} compact /> : null}
                          {mayAddMilestone ? <AddMilestoneOnDayForm projectId={projectId} dueOn={date} compact /> : null}
                          {mayProposeMeeting ? <ProposeMeetingOnDayForm projectId={projectId} date={date} leads={leadOptions} agencyZone={agencyZone} compact /> : null}
                        </span>
                      </div>
                      <ul className="mt-1 flex flex-col gap-1">
                        {dayEntries.map((e) => (
                          <li key={`${e.id}-${date}`} className="flex flex-wrap items-center gap-2 text-[13px]">
                            <Badge tone={e.kind === 'milestone' ? 'brand' : e.kind === 'meeting' ? 'accent' : 'info'}>{e.kind}</Badge>
                            {e.time ? <span className="tabular text-xs text-muted">{e.time}</span> : null}
                            <Link href={e.href} className="hover:text-brand">
                              {e.label}
                            </Link>
                            <StatusBadge status={e.status} dot={false} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : (view === 'month' || view === 'list') ? (
            <EmptyState icon={<IconClock size={22} />} title="Nothing scheduled" description="Task due dates, milestone deadlines and booked meetings will appear here once they're set." />
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Upcoming Events" actions={<ViewAll href={`/projects/${projectId}/board`} />} />
            {upcoming.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing dated ahead.</p>
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                    <span className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <span className="text-[9px] font-semibold uppercase leading-none">{formatDayKey(e.date, { month: 'short' })}</span>
                      <span className="tabular text-base font-semibold leading-tight">{e.date.slice(8, 10)}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <Link href={e.href} className="block truncate text-[13px] font-medium text-foreground hover:underline">{e.label}</Link>
                      <span className="block text-xs text-muted">{humanize(e.kind)} · {e.status.replace('_', ' ')}{e.time ? ` · ${e.time}` : ''}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Milestones on Calendar" actions={<ViewAll href={`/projects/${projectId}/plan`} />} />
            {milestones.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No milestones planned.</p>
            ) : (
              <ul className="divide-y divide-line">
                {milestones.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                    <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', m.met_at ? 'bg-success text-white' : m.due_on && m.due_on < today ? 'bg-danger-soft text-danger' : 'border border-line-strong bg-surface text-muted')}>
                      {m.met_at ? <IconCheck size={13} /> : <IconFlag size={12} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {m.name}
                      </span>
                      <span className="block text-xs text-muted">{m.met_at ? `Met ${clock.date(m.met_at)}` : m.due_on ? `Due ${clock.date(m.due_on)}` : 'No date'}</span>
                    </span>
                    <StatusBadge status={m.met_at ? 'completed' : m.status} dot={false} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* SCR-022 "Changes must preserve history and notify affected owners": the dates that moved, who moved them, from the audit trail. The people they concern see them in Notifications. */}
          <Card>
            <CardHeader title="Schedule Changes" description="Every due date that moved on this project, newest first. The people it concerns are told in Notifications." />
            {scheduleChanges.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No date has moved on this project.</p>
            ) : (
              <ul className="divide-y divide-line">
                {scheduleChanges.map((c) => (
                  <li key={c.auditId} className="flex flex-col gap-0.5 px-4 py-2.5 text-[13px] sm:px-5">
                    <Link href={scheduleChangeHref(c)} className="truncate font-medium text-foreground hover:underline">{c.label}</Link>
                    <span className="text-xs text-muted">{SCHEDULE_KIND_LABEL[c.kind]}: {describeScheduleMove(c, (d) => clock.date(d))}</span>
                    <span className="text-xs text-muted">{c.actorName ? `by ${c.actorName} · ` : ''}{clock.dateTime(c.changedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* SCR-022 "Sync supported calendars": a subscribable ICS feed — the honest sync without OAuth. */}
          <Card>
            <CardHeader title="Sync to your calendar" description="A private feed URL Google Calendar, Apple Calendar and Outlook can subscribe to." />
            <CalendarFeedPanel projectId={projectId} feed={feed} appUrl={clientEnv.NEXT_PUBLIC_APP_URL} fetchedLabel={feed?.lastFetchedAt ? clock.dateTime(feed.lastFetchedAt) : null} />
          </Card>

          <QuickActions
            title="Quick Actions"
            actions={[
              ...(can(context, 'task.write') ? [{ label: 'Add task', icon: <IconPlus size={13} />, href: `/projects/${projectId}/board` }] : []),
              ...(can(context, 'milestone.write') ? [{ label: 'Plan milestones', icon: <IconFlag size={13} />, href: `/projects/${projectId}/plan` }] : []),
              { label: 'Board', icon: <IconGrid size={13} />, href: `/projects/${projectId}/board` },
              { label: 'Meetings', icon: <IconCalendar size={13} />, href: '/meetings' },
            ]}
          />
        </div>
      </div>

      <Card>
        <CardHeader title="Calendar Filters" />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 pb-4 text-[13px] sm:px-5">
          {KINDS.map((k) => (
            <Link key={k} href={link(view, anchor, toggleKind(k))} className="inline-flex items-center gap-2 text-foreground">
              <span aria-hidden className={cx('flex h-4 w-4 items-center justify-center rounded border', kinds.has(k) ? 'border-brand bg-brand text-brand-fg' : 'border-line-strong bg-surface')}>
                {kinds.has(k) ? <IconCheck size={11} /> : null}
              </span>
              Show {humanize(k)}s
              <span className="sr-only">{kinds.has(k) ? '(on)' : '(off)'}</span>
            </Link>
          ))}
          {kinds.size !== KINDS.length ? <Link href={link(view, anchor, new Set(KINDS))} className="text-brand hover:underline">Reset</Link> : null}
        </div>
      </Card>
    </div>
  );
}
