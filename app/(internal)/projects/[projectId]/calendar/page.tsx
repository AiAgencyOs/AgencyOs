import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listPaymentPlan } from '@/modules/projects/queries';
import {
  Badge,
  Card,
  CardHeader,
  cx,
  EmptyState,
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

export const metadata: Metadata = { title: 'Calendar' };

type CalendarEntry = { date: string; label: string; kind: 'task' | 'milestone'; status: string; overdue: boolean };

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
  searchParams: Promise<{ month?: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/calendar`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const [{ tasks }, milestones, clientName] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    listPaymentPlan(projectId),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);

  const today = clock.dayKey(new Date());
  const entries: CalendarEntry[] = [];

  for (const t of tasks) {
    if (!t.dueOn || t.status === 'done') continue;
    entries.push({ date: t.dueOn, label: t.title, kind: 'task', status: t.status, overdue: t.dueOn < today });
  }
  for (const m of milestones) {
    if (!m.due_on || m.status === 'met') continue;
    entries.push({ date: m.due_on, label: m.name, kind: 'milestone', status: m.status, overdue: m.due_on < today });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));

  const byDate = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }

  const { month: requestedMonth } = await searchParams;
  const month = requestedMonth && /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : today.slice(0, 7);

  const gridEntriesByDate: Record<string, GridEntry[]> = {};
  for (const [date, dayEntries] of byDate) {
    gridEntriesByDate[date] = dayEntries.map((e) => ({
      label: e.label,
      tone: e.overdue ? 'danger' : e.kind === 'milestone' ? 'brand' : 'info',
      href: e.kind === 'milestone' ? `/projects/${projectId}/plan` : `/projects/${projectId}/board`,
    }));
  }

  const upcoming = entries.filter((e) => e.date >= today).slice(0, 6);
  const overdueCount = entries.filter((e) => e.overdue).length;

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={can(context.role, 'project.write')} />

      <ProjectSubNav projectId={projectId} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader
              title="Project calendar"
              description="View all project tasks, milestones and important dates in one place."
              actions={
                <span className="flex items-center gap-2 text-xs text-muted">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-info" /> Task</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand" /> Milestone</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-danger" /> Overdue</span>
                </span>
              }
            />
            <div className="p-3 sm:p-4">
              <MonthGrid month={month} entriesByDate={gridEntriesByDate} todayKey={today} monthHref={(m) => `/projects/${projectId}/calendar?month=${m}`} />
            </div>
          </Card>

          {byDate.size > 0 ? (
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
                      <p className={cx('text-[13px] font-medium', date < today ? 'text-danger' : 'text-foreground')}>
                        {formatDayKey(date)}
                        {date < today ? ' — overdue' : date === today ? ' — today' : ''}
                      </p>
                      <ul className="mt-1 flex flex-col gap-1">
                        {dayEntries.map((e) => (
                          <li key={`${e.kind}-${e.label}-${date}`} className="flex flex-wrap items-center gap-2 text-[13px]">
                            <Badge tone={e.kind === 'milestone' ? 'brand' : 'info'}>{e.kind}</Badge>
                            <Link href={e.kind === 'milestone' ? `/projects/${projectId}/plan` : `/projects/${projectId}/board`} className="hover:text-brand">
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
          ) : (
            <EmptyState icon={<IconClock size={22} />} title="Nothing scheduled" description="Task due dates and milestone deadlines will appear here once they're set." />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Upcoming" actions={<ViewAll href={`/projects/${projectId}/board`} />} />
            {upcoming.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing dated ahead.</p>
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.map((e) => (
                  <li key={`${e.kind}-${e.label}-${e.date}`} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                    <span className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <span className="text-[9px] font-semibold uppercase leading-none">{formatDayKey(e.date, { month: 'short' })}</span>
                      <span className="tabular text-base font-semibold leading-tight">{e.date.slice(8, 10)}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">{e.label}</span>
                      <span className="block text-xs text-muted">{e.kind === 'milestone' ? 'Milestone' : 'Task'} · {e.status.replace('_', ' ')}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Milestones on calendar" actions={<ViewAll href={`/projects/${projectId}/plan`} />} />
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

          <QuickActions
            actions={[
              ...(can(context.role, 'task.write') ? [{ label: 'Add task', icon: <IconPlus size={13} />, href: `/projects/${projectId}/board` }] : []),
              ...(can(context.role, 'milestone.write') ? [{ label: 'Plan milestones', icon: <IconFlag size={13} />, href: `/projects/${projectId}/plan` }] : []),
              { label: 'Board', icon: <IconGrid size={13} />, href: `/projects/${projectId}/board` },
              { label: 'Meetings', icon: <IconCalendar size={13} />, href: '/meetings' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
