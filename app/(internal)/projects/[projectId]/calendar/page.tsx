import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listPaymentPlan } from '@/modules/projects/queries';
import { Badge, EmptyState, IconClock, PageHeader } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Calendar' };

type CalendarEntry = { date: string; label: string; kind: 'task' | 'milestone'; status: string; overdue: boolean };

/**
 * SCR-022 — Project Calendar. List mode only: tasks and milestones grouped
 * by date, both from readers this project page already has
 * (listDevelopmentBreakdown, listPaymentPlan) — no new query. Meetings are
 * deliberately excluded: `crm.meetings` links to a lead, never a project, so
 * a per-project meeting calendar would be inventing a relationship the
 * schema does not have. Month/week/day grid views are not built — this is
 * the one of the PDF's four modes the existing date data can support
 * honestly without a calendar-grid component this session did not scope.
 */
export default async function ProjectCalendarPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/calendar`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

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

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Calendar`} description="Task due dates and milestone deadlines, soonest first." />

      <ProjectSubNav projectId={projectId} />

      {byDate.size > 0 ? (
        <div className="flex flex-col gap-3">
          {[...byDate.entries()].map(([date, dayEntries]) => (
            <div key={date} className="rounded-lg border border-line bg-surface p-4">
              <h3 className={`text-sm font-semibold ${date < today ? 'text-danger' : ''}`}>
                {clock.day(`${date}T00:00:00`)}
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
