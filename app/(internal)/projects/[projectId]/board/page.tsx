import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listTasksByMilestone } from '@/modules/projects/milestone-tasks-queries';
import { listAssigneeCandidates } from '@/modules/projects/project-members-queries';
import { getProject, listDevelopmentBreakdown, listInternalRoster, listPaymentPlan } from '@/modules/projects/queries';
import { readTaskCollabFor } from '@/modules/projects/task-collab-queries';
import { IconAlert, IconCheck, IconClock, IconList, IconSearch, PermissionDenied, statusTone, type KanbanColumn } from '@/ui';

import { ProjectBoard, type BoardTask } from './board-client';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

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
export default async function ProjectBoardPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ milestone?: string }> }) {
  const { projectId } = await params;
  const { milestone: initialMilestone } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/board`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  // SCR-020: the assignee list reads from the project's members (20261001120000)
  // and falls back to the organisation roster when the project has none; the
  // phase filter is the payment milestone a task is filed under.
  const [{ tasks, modules }, roster, clock, clientName, candidates, tasksByMilestone, milestones] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    listInternalRoster(),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    listAssigneeCandidates(projectId),
    listTasksByMilestone(projectId),
    listPaymentPlan(projectId),
  ]);
  const milestoneByTask = new Map<string, string>();
  for (const [milestoneId, list] of Object.entries(tasksByMilestone)) for (const t of list) milestoneByTask.set(t.id, milestoneId);
  const milestoneName = new Map(milestones.map((m) => [m.id, m.name]));
  // SCR-020: the blocker, checklist, comments and attachments for every
  // card, read once for the whole board so each drawer opens from data the
  // page already holds.
  const collab = await readTaskCollabFor(tasks.map((t) => t.id), clock);
  const nameByUser = new Map(roster.map((r) => [r.userId, r.fullName]));
  const moduleById = new Map(modules.map((m) => [m.id, m.name]));
  const canWrite = can(context, 'task.write');
  const todayKey = new Date().toISOString().slice(0, 10);

  const boardTasks: BoardTask[] = tasks.map((t) => ({
    id: t.id,
    columnId: t.status,
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
    milestoneId: milestoneByTask.get(t.id) ?? null,
    milestoneName: milestoneByTask.has(t.id) ? (milestoneName.get(milestoneByTask.get(t.id) as string) ?? null) : null,
  }));

  const assignees = [...new Set(tasks.map((t) => t.assigneeId).filter((id): id is string => id !== null))]
    .map((id) => ({ userId: id, fullName: nameByUser.get(id) ?? 'Unknown' }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={can(context, 'project.write')} />

      <ProjectSubNav projectId={projectId} />

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
        canWrite={canWrite}
        collab={collab}
      />
    </div>
  );
}
