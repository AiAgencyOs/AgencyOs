import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listInternalRoster, type DevelopmentTask } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, IconProjects, PageHeader, statusTone } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Board' };

const COLUMNS: { status: string; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'in_review', label: 'In review' },
  { status: 'done', label: 'Done' },
];

function TaskCard({ task, assigneeName }: { task: DevelopmentTask; assigneeName: string | null }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3 shadow-xs">
      <p className="text-[13px] font-medium leading-snug text-foreground">{task.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={task.priority === 'p0' ? 'danger' : task.priority === 'p1' ? 'warning' : 'neutral'}>
          {task.priority.toUpperCase()}
        </Badge>
        {assigneeName ? <span className="text-xs text-muted">{assigneeName}</span> : null}
      </div>
      {task.dueOn ? <p className="mt-1.5 text-xs text-muted">Due {task.dueOn}</p> : null}
    </div>
  );
}

/**
 * SCR-020 — Project Board. A workflow-state view of the same tasks the
 * Development page already lists by module: here grouped by `status`
 * instead, which is the question a PM scanning "what's blocked right now"
 * actually has — the module view answers a different one ("what's in this
 * piece of the build"). Read-only: moving a card's status is still done from
 * the Development page's existing task actions, so this adds no second
 * writer for the same column.
 */
export default async function ProjectBoardPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/board`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ tasks, modules }, roster] = await Promise.all([listDevelopmentBreakdown(projectId), listInternalRoster()]);
  const nameByUser = new Map(roster.map((r) => [r.userId, r.fullName]));

  // SCR-020: open-task counts per assignee and per module, on the board
  // itself. "Open" excludes done, because a chip that counts finished work
  // answers a question nobody scanning a board is asking.
  const open = tasks.filter((t) => t.status !== 'done');
  const countBy = (key: (t: DevelopmentTask) => string | null): [string | null, number][] => {
    const counts = new Map<string | null, number>();
    for (const t of open) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  const byAssignee = countBy((t) => t.assigneeId);
  const byModule = countBy((t) => t.moduleId);
  const moduleNameById = new Map(modules.map((m) => [m.id, m.name]));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Board`}
        description={tasks.length === 0 ? 'No tasks yet.' : `${tasks.length} task${tasks.length === 1 ? '' : 's'}, by status.`}
      />

      <ProjectSubNav projectId={projectId} />

      {open.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-muted">By assignee</span>
            {byAssignee.map(([assigneeId, count]) => (
              <Badge key={assigneeId ?? 'unassigned'} tone={assigneeId ? 'neutral' : 'warning'}>
                {assigneeId ? (nameByUser.get(assigneeId) ?? 'Unknown member') : 'Unassigned'} · {count}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-muted">By module</span>
            {byModule.map(([moduleId, count]) => (
              <Badge key={moduleId ?? 'none'} tone={moduleId ? 'brand' : 'neutral'}>
                {moduleId ? (moduleNameById.get(moduleId) ?? 'Unknown module') : 'No module'} · {count}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {tasks.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {COLUMNS.map((col) => {
            const colTasks = tasks.filter((t) => t.status === col.status);
            return (
              <Card key={col.status} className="flex flex-col">
                <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                    <Badge tone={statusTone(col.status)} dot>
                      {col.label}
                    </Badge>
                  </span>
                  <span className="text-xs text-muted tabular">{colTasks.length}</span>
                </div>
                <div className="flex flex-1 flex-col gap-2 p-2">
                  {colTasks.length > 0 ? (
                    colTasks.map((t) => (
                      <TaskCard key={t.id} task={t} assigneeName={t.assigneeId ? (nameByUser.get(t.assigneeId) ?? null) : null} />
                    ))
                  ) : (
                    <p className="px-2 py-3 text-center text-xs text-faint">Empty</p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
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
