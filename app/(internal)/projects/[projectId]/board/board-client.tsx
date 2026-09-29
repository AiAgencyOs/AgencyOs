'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setTaskStatusAction } from '@/modules/projects/actions';
import { Badge, Callout, IconAlert, KanbanBoard, type KanbanColumn, type KanbanItem } from '@/ui';

export type BoardTask = KanbanItem & {
  title: string;
  priority: string;
  assigneeName: string | null;
  dueOn: string | null;
};

/**
 * The interactive half of the Project Board (SCR-020). A client component
 * because dragging is inherently client-side; the write itself still goes
 * through `setTaskStatusAction` — the exact same Server Action the
 * Development page's own status dropdown calls — so this adds no second
 * writer for `projects.tasks.status`. `task.write` is re-checked inside that
 * action regardless of what this component sends, so a read-only role seeing
 * `disabled` cards is a UX courtesy, not the actual enforcement.
 */
export function ProjectBoard({
  projectId,
  columns,
  tasks,
  canWrite,
}: {
  projectId: string;
  columns: KanbanColumn[];
  tasks: BoardTask[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function handleMove(taskId: string, toStatus: string) {
    setError(null);
    const formData = new FormData();
    formData.set('taskId', taskId);
    formData.set('status', toStatus);
    formData.set('projectId', projectId);

    const result = await setTaskStatusAction(IDLE_STATE, formData);
    if (result.status === 'error') {
      setError(result.message ?? 'Could not move this task.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Callout tone="danger" icon={<IconAlert size={16} />}>
          {error}
        </Callout>
      ) : null}
      <KanbanBoard
        columns={columns}
        items={tasks}
        disabled={!canWrite}
        onMove={handleMove}
        renderCard={(task) => (
          <div className="rounded-lg border border-line bg-surface p-3 shadow-xs">
            <p className="text-[13px] font-medium leading-snug text-foreground">{task.title}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={task.priority === 'p0' ? 'danger' : task.priority === 'p1' ? 'warning' : 'neutral'}>
                {task.priority.toUpperCase()}
              </Badge>
              {task.assigneeName ? <span className="text-xs text-muted">{task.assigneeName}</span> : null}
            </div>
            {task.dueOn ? <p className="mt-1.5 text-xs text-muted">Due {task.dueOn}</p> : null}
          </div>
        )}
      />
    </div>
  );
}
