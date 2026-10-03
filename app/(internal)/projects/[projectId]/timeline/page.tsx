import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listMilestoneViews } from '@/modules/projects/milestone-view-queries';
import { dueLine, phaseState, phaseWindow, rollup, taskWindow, topLevelTasks } from '@/modules/projects/project-view-derive';
import { getProject, listDevelopmentBreakdown, listInternalRoster } from '@/modules/projects/queries';
import {
  Avatar,
  AvatarStack,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Gantt,
  HeaderFigure,
  humanize,
  IconCalendar,
  IconCheck,
  IconClock,
  IconUsers,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  type GanttRow,
} from '@/ui';

import { buttonClass } from '@/ui';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Timeline' };

const TASK_STATE = (status: string, dueOn: string | null, today: string): GanttRow['state'] =>
  status === 'done' ? 'done' : dueOn !== null && dueOn < today ? 'late' : status === 'todo' ? 'upcoming' : 'current';

/**
 * The project's Timeline tab: a Gantt of the phases (payment milestones) with
 * each phase's tasks as sub-rows. A task's bar runs from its start date to its
 * due date (both are edited on the task); a task with one date is a one-day
 * bar and a task with none is listed below, not drawn. Nothing on this page
 * writes.
 */
export default async function ProjectTimelinePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await requireInternal(`/projects/${projectId}/timeline`);
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const project = await getProject(projectId);
  if (!project) notFound();

  const [milestones, { tasks: allTasks }, roster, clock, clientName] = await Promise.all([
    listMilestoneViews(projectId),
    listDevelopmentBreakdown(projectId, { excludeCancelled: true }),
    listInternalRoster(),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const tasks = topLevelTasks(allTasks);
  const today = clock.dayKey(new Date());
  const base = `/projects/${projectId}`;
  const nameByUser = new Map(roster.map((r) => [r.userId, r.fullName]));
  const whole = rollup(tasks);
  const daysLeft = project.ends_on ? Math.ceil((new Date(`${project.ends_on}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000) : null;

  const firstUnmet = milestones.find((m) => !m.metAt && m.status !== 'met')?.id ?? null;
  const rows: GanttRow[] = [];
  let previousDue: string | null = null;
  const undated: string[] = [];
  const dateRange = (w: { start: string; end: string }) => `${clock.date(w.start)} – ${clock.date(w.end)}`;

  milestones.forEach((m, i) => {
    const own = tasks.filter((t) => t.milestoneId === m.id);
    const roll = rollup(own);
    const meta = { id: m.id, name: m.name, dueOn: m.dueOn, metAt: m.metAt, status: m.status };
    const state = phaseState(meta, roll, today, m.id === firstUnmet);
    const window = phaseWindow(meta, previousDue, project.starts_on, own);
    previousDue = m.dueOn ?? previousDue;
    if (window) rows.push({ id: m.id, index: String(i + 1), label: m.name, caption: dateRange(window), start: window.start, end: window.end, state, progress: roll.percent, depth: 0, href: `${base}/milestones?milestone=${m.id}` });
    own.forEach((t, j) => {
      const w = taskWindow(t);
      if (!w) undated.push(t.title);
      else rows.push({ id: t.id, index: `${i + 1}.${j + 1}`, label: t.title, caption: dateRange(w), start: w.start, end: w.end, state: TASK_STATE(t.status, t.dueOn, today), depth: 1, statusLabel: humanize(t.status), href: `${base}/development/tasks/${t.id}` });
    });
  });
  const loose = tasks.filter((t) => t.milestoneId === null);
  const looseRows = loose.flatMap((t, j) => {
    const w = taskWindow(t);
    if (!w) {
      undated.push(t.title);
      return [];
    }
    return [{ id: t.id, index: `${milestones.length + 1}.${j + 1}`, label: t.title, caption: dateRange(w), start: w.start, end: w.end, state: TASK_STATE(t.status, t.dueOn, today), depth: 1 as const, statusLabel: humanize(t.status), href: `${base}/development/tasks/${t.id}` }];
  });
  if (looseRows.length > 0) {
    const first = looseRows.reduce((a, r) => (r.start < a ? r.start : a), looseRows[0]!.start);
    const last = looseRows.reduce((a, r) => (r.end > a ? r.end : a), looseRows[0]!.end);
    rows.push({ id: 'no-phase', index: String(milestones.length + 1), label: 'Tasks without a phase', caption: dateRange({ start: first, end: last }), start: first, end: last, state: 'current', depth: 0 }, ...looseRows);
  }

  const teamIds = [...new Set(tasks.map((t) => t.assigneeId).filter((id): id is string => id !== null))];
  const workload = teamIds
    .map((id) => {
      const mine = tasks.filter((t) => t.assigneeId === id);
      return { id, name: nameByUser.get(id) ?? 'Unknown', done: mine.filter((t) => t.status === 'done').length, total: mine.length };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const deadlines = tasks.filter((t) => t.status !== 'done' && t.dueOn !== null).sort((a, b) => (a.dueOn as string).localeCompare(b.dueOn as string)).slice(0, 4);

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context, 'project.write')}
        aside={
          <HeaderFigure value={`${whole.percent}%`} label="Overall progress">
            <ProgressBar value={whole.percent} showValue={false} label="Overall progress" tone="brand" />
          </HeaderFigure>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={5}>
        <Stat compact label="Project progress" value={`${whole.percent}%`} caption={`${whole.done} of ${whole.total} tasks completed`} tone="brand" icon={<IconCheck size={16} />} />
        <Stat compact label="Due date" value={project.ends_on ? clock.date(project.ends_on) : '—'} caption={dueLine(project.ends_on, today)} tone={daysLeft !== null && daysLeft < 0 ? 'danger' : 'accent'} icon={<IconCalendar size={16} />} />
        <Stat compact label="Team members" value={String(teamIds.length)} caption="Holding a task" tone="info" icon={<IconUsers size={16} />} />
        <Stat compact label="Completed tasks" value={String(whole.done)} caption={`${whole.percent}% of all`} tone="success" icon={<IconCheck size={16} />} />
        <Stat compact label="Pending tasks" value={String(whole.total - whole.done)} caption="Not yet done" tone="warning" icon={<IconClock size={16} />} />
      </StatGrid>

      <Card>
        <CardHeader
          title="Project timeline"
          description="Phases and their tasks against the calendar."
          actions={
            <>
              <Link href={`${base}/tasks`} className={buttonClass('secondary', 'sm')}>List</Link>
              <Link href={`${base}/calendar`} className={buttonClass('secondary', 'sm')}>Calendar</Link>
            </>
          }
        />
        <div className="px-2 pb-4 sm:px-3">
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing is dated yet"
              description="A bar needs a task with a start or due date, or a milestone with a due date. Set them on the task page or the plan."
              action={<Link href={`${base}/tasks`} className={buttonClass('secondary', 'sm')}>Open the task list</Link>}
            />
          ) : (
            <Gantt rows={rows} todayKey={today} heading="Task / Phase" />
          )}
          {undated.length > 0 ? <p className="px-2 pt-2 text-xs text-muted">{undated.length} task{undated.length === 1 ? ' has' : 's have'} no start or due date and {undated.length === 1 ? 'is' : 'are'} not drawn.</p> : null}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Milestones" actions={<Link href={`${base}/milestones`} className="text-[13px] font-medium text-brand hover:underline">View All</Link>} />
          {milestones.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No milestones planned yet.</p>
          ) : (
            <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
              {milestones.slice(0, 5).map((m) => (
                <li key={m.id} className="flex items-center gap-2 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                  <span className="whitespace-nowrap text-xs text-muted">{m.dueOn ? clock.date(m.dueOn) : '—'}</span>
                  <Badge tone={m.metAt ? 'success' : m.status === 'in_progress' ? 'info' : 'neutral'}>{m.metAt ? 'Completed' : humanize(m.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Team workload" />
          {workload.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No task is assigned yet.</p>
          ) : (
            <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
              {workload.map((w) => (
                <li key={w.id} className="flex items-center gap-2 text-[13px]">
                  <Avatar name={w.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  <span className="tabular text-xs text-muted">{w.done} / {w.total} tasks</span>
                </li>
              ))}
              <li className="pt-1"><AvatarStack names={workload.map((w) => w.name)} max={5} /></li>
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Upcoming deadlines" />
          {deadlines.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No open task has a due date.</p>
          ) : (
            <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
              {deadlines.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-2 text-[13px]">
                  <Link href={`${base}/development/tasks/${t.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{t.title}</Link>
                  <span className="whitespace-nowrap text-xs text-muted">{clock.date(t.dueOn as string)}</span>
                  <Badge tone={(t.dueOn as string) < today ? 'danger' : 'warning'}>{dueLine(t.dueOn, today)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
