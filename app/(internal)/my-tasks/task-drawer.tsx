'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { setTaskStatusAction, updateTaskAction } from '@/modules/projects/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import type { MyTaskDetail } from '@/modules/projects/my-tasks-queries';
import type { RosterMember } from '@/modules/projects/queries';
import { emptyTaskCollab, type TaskCollab } from '@/modules/projects/task-collab-types';
import { TASK_STATUSES } from '@/modules/projects/schema';
import {
  Badge,
  Drawer,
  FormMessage,
  buttonClass,
  humanize,
  inputClass,
  labelClass,
  selectClass,
  statusTone,
  textareaClass,
} from '@/ui';

import { BlockReasonField, TaskCollabPanel } from '../task-collab-panel';

const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;

/**
 * SCR-021 — the task drawer. Two doors, no client-side guesswork: status
 * goes through `setTaskStatusAction` (which owns `completed_at`), and the
 * task's own fields — title, description, priority, assignee, due date —
 * through `updateTaskAction`, the same door the Board's card editor uses.
 * Reassign is that same action with the assignee changed; the form carries
 * every field because the door saves the whole record. Each shows its own
 * refusal beside the control that earned it. Since 20260929140000 the
 * drawer also carries the task's blocker, checklist, comments and
 * attachments through `<TaskCollabPanel>`; choosing Blocked asks for the
 * reason before it submits.
 */
export function TaskDrawerButton({
  task,
  roster,
  collab,
  label,
  className,
}: {
  task: MyTaskDetail;
  roster: RosterMember[];
  collab?: TaskCollab;
  label?: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [statusState, statusAction, statusPending] = useActionState(setTaskStatusAction, IDLE_STATE);
  const [editState, editAction, editPending] = useActionState(updateTaskAction, IDLE_STATE);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className ?? 'text-left font-medium text-foreground underline-offset-2 hover:underline'}
      >
        {label ?? task.title}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={task.title}
        description={
          <>
            <Link href={`/projects/${task.projectId}/board`} className="underline-offset-2 hover:underline">
              {task.projectName}
            </Link>
            {task.moduleName ? <> · {task.moduleName}</> : null}
          </>
        }
        actions={<Badge tone={statusTone(task.status)} dot>{humanize(task.status)}</Badge>}
      >
        <div className="flex flex-col gap-5">
          <form action={statusAction} className="flex flex-col gap-1.5">
            <input type="hidden" name="projectId" value={task.projectId} />
            <input type="hidden" name="taskId" value={task.id} />
            <label className={labelClass} htmlFor={`status-${task.id}`}>
              Status
            </label>
            <select
              id={`status-${task.id}`}
              name="status"
              defaultValue={task.status}
              className={selectClass}
              disabled={statusPending}
              onChange={(e) => {
                if (e.currentTarget.value === 'blocked' && task.status !== 'blocked') setBlocking(true);
                else {
                  setBlocking(false);
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
            {blocking ? (
              <>
                <BlockReasonField taskId={task.id} />
                <div>
                  <button type="submit" disabled={statusPending} className={buttonClass('primary', 'sm')}>
                    {statusPending ? 'Blocking…' : 'Mark blocked'}
                  </button>
                </div>
              </>
            ) : null}
            <FormMessage status={statusState.status} message={statusState.message} />
          </form>

          <div className="border-t border-line pt-4">
            <TaskCollabPanel projectId={task.projectId} taskId={task.id} status={task.status} collab={collab ?? emptyTaskCollab(task.id)} canWrite compact />
          </div>

          <form action={editAction} className="flex flex-col gap-3 border-t border-line pt-4">
            <input type="hidden" name="projectId" value={task.projectId} />
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="estimateHours" value={task.estimateHours ?? ''} />
            <div className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor={`assignee-${task.id}`}>
                Assigned to
              </label>
              <select id={`assignee-${task.id}`} name="assigneeId" defaultValue={task.assigneeId ?? ''} className={selectClass}>
                <option value="">Unassigned</option>
                {roster.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.fullName} · {humanize(m.role)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted">Reassigning it to somebody else removes it from your list.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor={`title-${task.id}`}>
                Title
              </label>
              <input id={`title-${task.id}`} name="title" defaultValue={task.title} required maxLength={200} className={inputClass} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor={`description-${task.id}`}>
                Description
              </label>
              <textarea
                id={`description-${task.id}`}
                name="description"
                defaultValue={task.description ?? ''}
                maxLength={4000}
                rows={4}
                className={textareaClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`priority-${task.id}`}>
                  Priority
                </label>
                <select id={`priority-${task.id}`} name="priority" defaultValue={task.priority} className={selectClass}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={labelClass} htmlFor={`due-${task.id}`}>
                  Due
                </label>
                <input id={`due-${task.id}`} name="dueOn" type="date" defaultValue={task.dueOn ?? ''} className={inputClass} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="submit" disabled={editPending} className={buttonClass('primary', 'sm')}>
                {editPending ? 'Saving…' : 'Save changes'}
              </button>
              <FormMessage status={editState.status} message={editState.message} />
            </div>
          </form>
        </div>
      </Drawer>
    </>
  );
}
