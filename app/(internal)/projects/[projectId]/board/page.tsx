import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { overallProgress, overallProgressLabel } from '@/modules/projects/project-health';
import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listTasksByMilestone } from '@/modules/projects/milestone-tasks-queries';
import { listAssigneeCandidates } from '@/modules/projects/project-members-queries';
import { getProject, listDevelopmentBreakdown, listInternalRoster, listPaymentPlan, listProjectFiles, listProjectTeam } from '@/modules/projects/queries';
import { listProjectSprints } from '@/modules/projects/sprint-queries';
import { topLevelTasks } from '@/modules/projects/project-view-derive';
import { countPeriods, periodDelta, trendOf } from '@/lib/admin/period-delta';
import { readTaskCollabFor } from '@/modules/projects/task-collab-queries';
import Link from 'next/link';

import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  DonutChart,
  HeaderFigure,
  humanize,
  IconAlert,
  IconCheck,
  IconClock,
  IconFile,
  IconList,
  IconSearch,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  statusTone,
  Timeline,
  ViewAll,
  type KanbanColumn,
  type TimelineStep,
} from '@/ui';

import { ProjectBoard, type BoardTask } from './board-client';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';
import { readMyProjectRole } from '@/modules/projects/project-role-queries';

export const metadata: Metadata = { title: 'Board' };

const COLUMNS: KanbanColumn[] = [
  { id: 'todo', label: 'To do', tone: 'warning', icon: <IconList size={14} /> },
  { id: 'in_progress', label: 'In progress', tone: statusTone('in_progress'), icon: <IconClock size={14} /> },
  { id: 'in_review', label: 'Review', tone: 'brand', icon: <IconSearch size={14} /> },
  { id: 'done', label: 'Completed', tone: statusTone('done'), icon: <IconCheck size={14} /> },
  { id: 'blocked', label: 'Blocked', tone: statusTone('blocked'), icon: <IconAlert size={14} /> },
];

/**
 * SCR-020 — Project Board. A workflow-state view of the same tasks the
 * Development page already lists by module: here grouped by `status`
 * instead, which is the question a PM scanning "what's blocked right now"
 * actually has — the module view answers a different one ("what's in this
 * piece of the build"). Drag-and-drop and "+ Add task" both go through the
 * Development page's own Server Actions via `<ProjectBoard>`, so this
 * remains the same single writer for `projects.tasks` — just with a second
 * way to reach it.
 */
export default async function ProjectBoardPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ milestone?: string; sprint?: string }> }) {
  const { projectId } = await params;
  const { milestone: initialMilestone, sprint: initialSprint } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/board`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  // SCR-020: the assignee list reads from the project's members (20261001120000)
  // and falls back to the organisation roster when the project has none; the
  // phase filter is the payment milestone a task is filed under.
  const [{ tasks: allTasks, modules }, roster, clock, clientName, candidates, tasksByMilestone, milestones, team, files, sprints] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    listInternalRoster(),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    listAssigneeCandidates(projectId),
    listTasksByMilestone(projectId),
    listPaymentPlan(projectId),
    listProjectTeam(projectId),
    listProjectFiles(projectId),
    listProjectSprints(projectId),
  ]);
  // A subtask is drawn under its parent on the task page, not as a card of its own.
  const tasks = topLevelTasks(allTasks);
  const milestoneByTask = new Map<string, string>();
  for (const [milestoneId, list] of Object.entries(tasksByMilestone)) for (const t of list) milestoneByTask.set(t.id, milestoneId);
  const milestoneName = new Map(milestones.map((m) => [m.id, m.name]));
  // SCR-020: the blocker, checklist, comments and attachments for every
  // card, read once for the whole board so each drawer opens from data the
  // page already holds.
  const collab = await readTaskCollabFor(tasks.map((t) => t.id), clock);
  const nameByUser = new Map(roster.map((r) => [r.userId, r.fullName]));
  const moduleById = new Map(modules.map((m) => [m.id, m.name]));
  // Q-B2: an observer is read-only here; a contributor changes only the tasks assigned to them (the drawer says so per task).
  const manager = can(context, 'project.write');
  const projectRole = manager ? null : await readMyProjectRole(projectId, context.userId);
  const canWrite = can(context, 'task.write') && projectRole !== 'observer';
  const todayKey = new Date().toISOString().slice(0, 10);

  const boardTasks: BoardTask[] = tasks.map((t) => ({
    id: t.id,
    columnId: t.status,
    status: t.status,
    startOn: t.startOn,
    labels: t.labels,
    title: t.title,
    description: t.description,
    estimateHours: t.estimateHours ?? null,
    priority: t.priority,
    assigneeId: t.assigneeId,
    assigneeName: t.assigneeId ? (nameByUser.get(t.assigneeId) ?? null) : null,
    moduleId: t.moduleId,
    moduleName: t.moduleId ? (moduleById.get(t.moduleId) ?? null) : null,
    dueOn: t.dueOn,
    dueLabel: t.dueOn ? clock.date(t.dueOn) : null,
    completedLabel: t.completedAt ? clock.dateTime(t.completedAt) : null,
    overdue: t.status !== 'done' && t.dueOn !== null && t.dueOn < todayKey,
    sprintId: t.sprintId,
    milestoneId: milestoneByTask.get(t.id) ?? null,
    milestoneName: milestoneByTask.has(t.id) ? (milestoneName.get(milestoneByTask.get(t.id) as string) ?? null) : null,
  }));

  const assignees = [...new Set(tasks.map((t) => t.assigneeId).filter((id): id is string => id !== null))]
    .map((id) => ({ userId: id, fullName: nameByUser.get(id) ?? 'Unknown' }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const count = (id: string) => tasks.filter((t) => t.status === id).length;
  const pctOf = (n: number) => (tasks.length > 0 ? Math.round((n / tasks.length) * 100) : 0);
  const daysLeft = project.ends_on
    ? Math.ceil((new Date(`${project.ends_on}T00:00:00Z`).getTime() - new Date(`${todayKey}T00:00:00Z`).getTime()) / 86_400_000)
    : null;
  // One progress figure on every project screen (milestones met, else tasks done).
  const overall = overallProgress({ milestonesTotal: milestones.length, milestonesMet: milestones.filter((m) => m.met_at).length, tasksTotal: tasks.length, tasksDone: count('done') });

  let currentSeen = false;
  const steps: TimelineStep[] = milestones.map((m) => {
    const dates = m.due_on ? clock.date(m.due_on) : undefined;
    if (m.met_at) return { label: m.name, caption: `Completed${dates ? ` · ${dates}` : ''}`, state: 'done' };
    if (!currentSeen) {
      currentSeen = true;
      return { label: m.name, caption: `In progress${dates ? ` · ${dates}` : ''}`, state: 'current' };
    }
    return { label: m.name, caption: `Pending${dates ? ` · ${dates}` : ''}`, state: 'upcoming' };
  });

  const recentDone = tasks
    .filter((t) => t.completedAt)
    .sort((a, b) => (b.completedAt as string).localeCompare(a.completedAt as string))
    .slice(0, 4);
  const upcoming = tasks
    .filter((t) => t.status !== 'done' && t.dueOn !== null)
    .sort((a, b) => (a.dueOn as string).localeCompare(b.dueOn as string))
    .slice(0, 5);
  const donut = COLUMNS.map((c) => ({ label: c.label, value: count(c.id) }));

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context, 'project.write')}
        aside={
          <HeaderFigure value={`${overall}%`} label={overallProgressLabel({ milestonesTotal: milestones.length, tasksTotal: tasks.length })}>
            <ProgressBar value={overall} showValue={false} label="Overall progress" tone="brand" />
          </HeaderFigure>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={5}>
        <Stat compact label="Total tasks" value={String(tasks.length)} caption={`${count('done')} completed`} tone="brand" icon={<IconList size={16} />} trend={trendOf(periodDelta(countPeriods(tasks.map((t) => t.createdAt), new Date())))} />
        <Stat compact label="In progress" value={String(count('in_progress'))} caption={`${pctOf(count('in_progress'))}%`} tone="warning" icon={<IconClock size={16} />} />
        <Stat compact label="In review" value={String(count('in_review'))} caption={`${pctOf(count('in_review'))}%`} tone="accent" icon={<IconSearch size={16} />} />
        <Stat compact label="Pending" value={String(count('todo'))} caption={`${pctOf(count('todo'))}%`} tone="danger" icon={<IconList size={16} />} />
        <Stat compact label="Days left" value={daysLeft === null ? '—' : String(daysLeft)} caption={project.ends_on ? `Due ${clock.date(project.ends_on)}` : 'No due date set'} tone={daysLeft !== null && daysLeft < 0 ? 'danger' : 'info'} icon={<IconAlert size={16} />} />
      </StatGrid>

      <ProjectBoard
            projectId={projectId}
            columns={COLUMNS}
            tasks={boardTasks}
            modules={modules.map((m) => ({ id: m.id, name: m.name }))}
            people={assignees}
            roster={candidates.people}
            rosterSource={candidates.source}
            milestones={milestones.map((m) => ({ id: m.id, name: m.name }))}
            initialMilestone={initialMilestone && milestoneName.has(initialMilestone) ? initialMilestone : ''}
            sprints={sprints.map((s) => ({ id: s.id, name: s.name }))}
            initialSprint={initialSprint && (initialSprint === 'none' || sprints.some((s) => s.id === initialSprint)) ? initialSprint : ''}
            canWrite={canWrite}
            projectRole={projectRole}
            collab={collab}
            currentUserId={context.userId}
            todayKey={todayKey}
            rail={
              <>
          <Card>
            <CardHeader title="Project timeline" actions={<ViewAll href={`/projects/${projectId}/plan`} />} />
            <div className="px-4 pb-4 sm:px-5">
              {steps.length === 0 ? (
                <p className="text-[13px] text-muted">No milestones planned yet.</p>
              ) : (
                <Timeline steps={steps} orientation="vertical" label="Project phases" />
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Team members" actions={<ViewAll href={`/projects/${projectId}/team`} />} />
            {team.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No one assigned yet.</p>
            ) : (
              <ul className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                {team.slice(0, 5).map((m) => (
                  <li key={m.userId} className="flex items-center gap-3">
                    <Avatar name={m.fullName} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">{m.fullName}</span>
                      <span className="block truncate text-xs text-muted">{humanize(m.role)}</span>
                    </span>
                  </li>
                ))}
                {team.length > 5 ? (
                  <li>
                    <Link href={`/projects/${projectId}/team`} className="text-xs font-medium text-brand hover:underline">+{team.length - 5} more members</Link>
                  </li>
                ) : null}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Task summary" />
            <div className="px-4 pb-4 sm:px-5 [&>div]:sm:flex-col! [&>div]:sm:items-start!">
              {tasks.length === 0 ? <p className="text-[13px] text-muted">No tasks to summarise.</p> : <DonutChart data={donut} height={150} totalLabel="Total tasks" />}
            </div>
          </Card>
              </>
            }
          />

      <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Recent activity" actions={<ViewAll href={`/projects/${projectId}/activity`} />} />
              {recentDone.length === 0 ? (
                <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing has been completed on this board yet.</p>
              ) : (
                <ul className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                  {recentDone.map((t) => {
                    const who = t.assigneeId ? (nameByUser.get(t.assigneeId) ?? null) : null;
                    return (
                      <li key={t.id} className="flex items-start gap-3">
                        <Avatar name={who ?? 'Unassigned'} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] text-foreground">
                            <span className="font-medium">{who ?? 'Someone'}</span> completed {t.title}
                          </span>
                          <span className="block text-xs text-muted">{clock.dateTime(t.completedAt as string)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader title="Upcoming deadlines" actions={<ViewAll href={`/projects/${projectId}/calendar`} />} />
              {upcoming.length === 0 ? (
                <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No open task has a due date.</p>
              ) : (
                <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
                  {upcoming.map((t) => {
                    const days = Math.ceil((new Date(`${t.dueOn}T00:00:00Z`).getTime() - new Date(`${todayKey}T00:00:00Z`).getTime()) / 86_400_000);
                    return (
                      <li key={t.id} className="flex items-center gap-2 text-[13px]">
                        <span aria-hidden className={days < 0 ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-danger' : 'h-1.5 w-1.5 shrink-0 rounded-full bg-brand'} />
                        <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
                        <span className="shrink-0 text-xs text-muted">{clock.date(t.dueOn as string)}</span>
                        <Badge tone={days < 0 ? 'danger' : days === 0 ? 'warning' : 'neutral'}>{days < 0 ? 'Overdue' : days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader title="Project files" actions={<ViewAll href={`/projects/${projectId}/files`} />} />
              {files.length === 0 ? (
                <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No files yet.</p>
              ) : (
                <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
                  {files.slice(0, 4).map((f) => (
                    <li key={f.id}>
                      <a href={f.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2.5 hover:underline">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                          <IconFile size={15} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-foreground">{f.title}</span>
                          <span className="block truncate text-xs text-muted">{humanize(f.category)} · {clock.date(f.createdAt)}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
    </div>
  );
}
