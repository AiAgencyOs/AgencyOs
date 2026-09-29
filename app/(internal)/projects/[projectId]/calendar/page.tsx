import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listPaymentPlan } from '@/modules/projects/queries';
import { Badge, EmptyState, IconClock, MonthGrid, PageHeader, type CalendarEntry as GridEntry, PermissionDenied } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Calendar' };

type CalendarEntry = { date: string; label: string; kind: 'task' | 'milestone'; status: string; overdue: boolean };

/**
 * `YYYY-MM-DD` → "Weekday, D Month", with no timezone conversion at all.
 *
 * The previous version of this heading was `clock.day(`${date}T00:00:00`)` —
 * appending a fake midnight and letting `Intl.DateTimeFormat` reinterpret it
 * in the agency's configured timezone. `date` here has no time component to
 * begin with (`projects.tasks.due_on` and `.milestones.due_on` are both plain
 * SQL `date` columns), so that round-trip could shift the displayed day by
 * one whenever the server process's local zone and the agency's configured
 * zone disagree on which side of midnight a bare "00:00:00" falls — exactly
 * the mismatch the calendar grid above (which never does this round-trip)
 * exposed by showing the same task on the correct day.
 */
function formatDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

/**
 * SCR-022 — Project Calendar. Tasks and milestones grouped by date, both from
 * readers this project page already has (listDevelopmentBreakdown,
 * listPaymentPlan) — no new query. Meetings are deliberately excluded:
 * `crm.meetings` links to a lead, never a project, so a per-project meeting
 * calendar would be inventing a relationship the schema does not have.
 *
 * The month grid reuses the same `entries` this page already computed for the
 * agenda list below it — one derivation, two views, so they can never show a
 * different set of dates for the same data.
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
  const [{ tasks }, milestones] = await Promise.all([listDevelopmentBreakdown(projectId), listPaymentPlan(projectId)]);

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
      tone: e.overdue ? 'danger' : e.kind === 'milestone' ? 'brand' : 'neutral',
      href: e.kind === 'milestone' ? `/projects/${projectId}` : `/projects/${projectId}/development`,
    }));
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Calendar`} description="Task due dates and milestone deadlines, soonest first." />

      <ProjectSubNav projectId={projectId} />

      {byDate.size > 0 ? (
        <MonthGrid
          month={month}
          entriesByDate={gridEntriesByDate}
          todayKey={today}
          monthHref={(m) => `/projects/${projectId}/calendar?month=${m}`}
        />
      ) : null}

      {byDate.size > 0 ? (
        <div className="flex flex-col gap-3">
          {[...byDate.entries()].map(([date, dayEntries]) => (
            <div key={date} className="rounded-lg border border-line bg-surface p-4">
              <h3 className={`text-sm font-semibold ${date < today ? 'text-danger' : ''}`}>
                {formatDayKey(date)}
                {date < today ? ' — overdue' : ''}
              </h3>
              <ul className="mt-2 flex flex-col gap-1">
                {dayEntries.map((e) => (
                  <li key={`${e.kind}-${e.label}-${date}`} className="flex items-center gap-2 text-[13px]">
                    <Badge tone={e.kind === 'milestone' ? 'brand' : 'neutral'}>{e.kind}</Badge>
                    <span>{e.label}</span>
                    <span className="text-xs text-muted">{e.status.replace('_', ' ')}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconClock size={22} />}
          title="Nothing scheduled"
          description="Task due dates and milestone deadlines will appear here once they're set."
        />
      )}
    </div>
  );
}
