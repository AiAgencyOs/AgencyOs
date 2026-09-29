import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { isDayKey, shiftDay } from '@/lib/admin/month-grid';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listInternalRoster } from '@/modules/projects/queries';
import { listReportTasks, weekStartOf, weeksBetween } from '@/modules/projects/report-queries';
import {
  Card,
  CardHeader,
  EmptyState,
  FilterBar,
  IconClock,
  PageHeader,
  Stat,
  StatGrid,
  buttonClass,
  cx,
  humanize,
  inputClass,
  labelClass,
} from '@/ui';

import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Reports' };

/** Default window: the last twelve weeks, ending today. */
const DEFAULT_WEEKS = 12;

/**
 * SCR-026 — Project Reports: a completion trend from `tasks.completed_at`
 * by ISO week, a `?from=&to=` range, and a CSV of the same rows from
 * `/api/projects/[projectId]/report`. One reader (`listReportTasks`) feeds
 * both so the file never disagrees with the page.
 *
 * The chart is a single series, so it carries no legend: the title names
 * it. Each bar's exact count is in its hover title and in the table below,
 * which is also the accessible reading.
 */
export default async function ProjectReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { projectId } = await params;
  const { from: rawFrom, to: rawTo } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/reports`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const today = clock.dayKey(new Date());
  const to = isDayKey(rawTo) ? rawTo : today;
  const from = isDayKey(rawFrom) && rawFrom <= to ? rawFrom : shiftDay(to, -(DEFAULT_WEEKS * 7 - 1));

  const [tasks, { modules }, roster] = await Promise.all([
    listReportTasks(projectId, { from, to }),
    listDevelopmentBreakdown(projectId),
    listInternalRoster(),
  ]);

  const completed = tasks.filter((t) => t.completedAt !== null);
  const open = tasks.filter((t) => t.completedAt === null && t.status !== 'done');
  const overdue = open.filter((t) => t.dueOn !== null && t.dueOn < today);

  const weeks = weeksBetween(from, to);
  const countByWeek = new Map<string, number>(weeks.map((w) => [w, 0]));
  for (const t of completed) {
    const week = weekStartOf(clock.dayKey(t.completedAt as string));
    if (countByWeek.has(week)) countByWeek.set(week, (countByWeek.get(week) ?? 0) + 1);
  }
  const series = weeks.map((w) => ({ week: w, count: countByWeek.get(w) ?? 0 }));
  const max = Math.max(1, ...series.map((s) => s.count));

  const moduleName = new Map(modules.map((m) => [m.id, m.name]));
  const memberName = new Map(roster.map((r) => [r.userId, r.fullName]));
  const byAssignee = new Map<string | null, { done: number; open: number }>();
  for (const t of tasks) {
    const entry = byAssignee.get(t.assigneeId) ?? { done: 0, open: 0 };
    if (t.completedAt) entry.done += 1;
    else if (t.status !== 'done') entry.open += 1;
    byAssignee.set(t.assigneeId, entry);
  }

  const base = `/projects/${projectId}/reports`;
  const csvHref = `/api/projects/${projectId}/report?from=${from}&to=${to}`;
  const weekLabel = (w: string) => clock.date(`${w}T00:00:00`);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Reports`}
        description={`Completions between ${clock.date(`${from}T00:00:00`)} and ${clock.date(`${to}T00:00:00`)}, by week.`}
        actions={
          <a href={csvHref} className={buttonClass('secondary', 'sm')}>
            Export CSV
          </a>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <FilterBar>
        <form action={base} method="GET" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>From</span>
            <input type="date" name="from" defaultValue={from} max={to} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>To</span>
            <input type="date" name="to" defaultValue={to} className={inputClass} />
          </label>
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Apply
          </button>
          {rawFrom || rawTo ? (
            <Link href={base} className={buttonClass('ghost', 'sm')}>
              Last {DEFAULT_WEEKS} weeks
            </Link>
          ) : null}
        </form>
      </FilterBar>

      <StatGrid>
        <Stat label="Completed in range" value={String(completed.length)} tone={completed.length > 0 ? 'success' : 'neutral'} />
        <Stat label="Still open" value={String(open.length)} />
        <Stat label="Overdue" value={String(overdue.length)} tone={overdue.length > 0 ? 'danger' : 'success'} />
        <Stat
          label="Per week"
          value={series.length > 0 ? (completed.length / series.length).toFixed(1) : '0'}
        />
      </StatGrid>

      <Card>
        <CardHeader title="Completion trend" description="Tasks completed per week (week starting Monday)." />
        {completed.length > 0 ? (
          <div className="px-4 py-4 sm:px-5">
            <div className="flex h-40 items-end gap-[2px] overflow-x-auto" role="img" aria-label="Tasks completed per week">
              {series.map((s) => (
                <div key={s.week} className="flex min-w-6 flex-1 flex-col items-center justify-end gap-1" title={`${weekLabel(s.week)}: ${s.count} completed`}>
                  {s.count > 0 ? <span className="text-[10px] tabular text-muted">{s.count}</span> : null}
                  <div
                    className={cx('w-full max-w-8 rounded-t-[4px] bg-brand transition-colors hover:bg-brand-hover', s.count === 0 && 'bg-line')}
                    style={{ height: `${Math.max(2, Math.round((s.count / max) * 120))}px` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted">
              <span>{weekLabel(series[0]?.week ?? from)}</span>
              <span>{weekLabel(series[series.length - 1]?.week ?? to)}</span>
            </div>
            <details className="mt-3 text-[13px]">
              <summary className="cursor-pointer text-muted">As a table</summary>
              <table className="mt-2 w-full max-w-sm text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                    <th className="py-1 font-semibold">Week of</th>
                    <th className="py-1 text-right font-semibold">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr key={s.week} className="border-t border-line">
                      <td className="py-1">{weekLabel(s.week)}</td>
                      <td className="py-1 text-right tabular">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        ) : (
          <EmptyState
            icon={<IconClock size={20} />}
            title="No completions in this range"
            description="Tasks marked done carry the moment they were completed; none fall inside these dates."
          />
        )}
      </Card>

      <Card>
        <CardHeader title="By person" description="Completions in range and what each person still has open." />
        {byAssignee.size > 0 ? (
          <ul className="divide-y divide-line">
            {[...byAssignee.entries()]
              .sort((a, b) => b[1].done - a[1].done)
              .map(([assigneeId, counts]) => (
                <li key={assigneeId ?? 'unassigned'} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className={cx('font-medium', !assigneeId && 'text-muted')}>
                    {assigneeId ? (memberName.get(assigneeId) ?? 'Unknown member') : 'Unassigned'}
                  </span>
                  <span className="tabular text-muted">
                    {counts.done} done · {counts.open} open
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No tasks on this project yet.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Completed tasks" description={`${completed.length} in range, most recent first.`} />
        {completed.length > 0 ? (
          <ul className="divide-y divide-line">
            {[...completed]
              .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
              .map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{t.title}</span>
                    <span className="block text-xs text-muted">
                      {t.moduleId ? `${moduleName.get(t.moduleId) ?? 'Module'} · ` : ''}
                      {t.assigneeId ? (memberName.get(t.assigneeId) ?? 'Unknown member') : 'Unassigned'} · {humanize(t.priority)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{clock.dateTime(t.completedAt as string)}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing completed in this range.</p>
        )}
      </Card>
    </div>
  );
}
