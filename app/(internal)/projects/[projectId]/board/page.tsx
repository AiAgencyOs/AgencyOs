import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listInternalRoster } from '@/modules/projects/queries';
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
export default async function ProjectBoardPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/board`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ tasks, modules }, roster, clock, clientName] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    listInternalRoster(),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const nameByUser = new Map(roster.map((r) => [r.userId, r.fullName]));
  const moduleById = new Map(modules.map((m) => [m.id, m.name]));
  const canWrite = can(context.role, 'task.write');
  const todayKey = new Date().toISOString().slice(0, 10);

  const boardTasks: BoardTask[] = tasks.map((t) => ({
    id: t.id,
    columnId: t.status,
    title: t.title,
    description: t.description,
    priority: t.priority,
    assigneeId: t.assigneeId,
    assigneeName: t.assigneeId ? (nameByUser.get(t.assigneeId) ?? null) : null,
    moduleId: t.moduleId,
    moduleName: t.moduleId ? (moduleById.get(t.moduleId) ?? null) : null,
    dueOn: t.dueOn,
    dueLabel: t.dueOn ? clock.date(t.dueOn) : null,
    completedLabel: t.completedAt ? clock.dateTime(t.completedAt) : null,
    overdue: t.status !== 'done' && t.dueOn !== null && t.dueOn < todayKey,
  }));

  const assignees = [...new Set(tasks.map((t) => t.assigneeId).filter((id): id is string => id !== null))]
    .map((id) => ({ userId: id, fullName: nameByUser.get(id) ?? 'Unknown' }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={can(context.role, 'project.write')} />

      <ProjectSubNav projectId={projectId} />

      <ProjectBoard
        projectId={projectId}
        columns={COLUMNS}
        tasks={boardTasks}
        modules={modules.map((m) => ({ id: m.id, name: m.name }))}
        people={assignees}
        canWrite={canWrite}
      />
    </div>
  );
}
