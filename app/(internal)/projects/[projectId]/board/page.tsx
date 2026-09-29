import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listInternalRoster } from '@/modules/projects/queries';
import { EmptyState, IconProjects, PageHeader, statusTone, type KanbanColumn, PermissionDenied } from '@/ui';

import { ProjectBoard, type BoardTask } from './board-client';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Board' };

const COLUMNS: KanbanColumn[] = [
  { id: 'todo', label: 'To do', tone: statusTone('todo') },
  { id: 'in_progress', label: 'In progress', tone: statusTone('in_progress') },
  { id: 'blocked', label: 'Blocked', tone: statusTone('blocked') },
  { id: 'in_review', label: 'In review', tone: statusTone('in_review') },
  { id: 'done', label: 'Done', tone: statusTone('done') },
];

/**
 * SCR-020 — Project Board. A workflow-state view of the same tasks the
 * Development page already lists by module: here grouped by `status`
 * instead, which is the question a PM scanning "what's blocked right now"
 * actually has — the module view answers a different one ("what's in this
 * piece of the build"). Drag-and-drop (added on top of the earlier read-only
 * version) still goes through the Development page's own `setTaskStatusAction`
 * via `<ProjectBoard>`, so this remains the same single writer for
 * `projects.tasks.status` — just with a second way to reach it.
 */
export default async function ProjectBoardPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/board`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ tasks }, roster] = await Promise.all([listDevelopmentBreakdown(projectId), listInternalRoster()]);
  const nameByUser = new Map(roster.map((r) => [r.userId, r.fullName]));
  const canWrite = can(context.role, 'task.write');

  const boardTasks: BoardTask[] = tasks.map((t) => ({
    id: t.id,
    columnId: t.status,
    title: t.title,
    priority: t.priority,
    assigneeName: t.assigneeId ? (nameByUser.get(t.assigneeId) ?? null) : null,
    dueOn: t.dueOn,
  }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Board`}
        description={
          tasks.length === 0
            ? 'No tasks yet.'
            : canWrite
              ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} — drag a card to change its status.`
              : `${tasks.length} task${tasks.length === 1 ? '' : 's'}, by status.`
        }
      />

      <ProjectSubNav projectId={projectId} />

      {boardTasks.length > 0 ? (
        <ProjectBoard projectId={projectId} columns={COLUMNS} tasks={boardTasks} canWrite={canWrite} />
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No tasks yet"
          description="Tasks created on the Development page will show up here, grouped by status."
        />
      )}
    </div>
  );
}
