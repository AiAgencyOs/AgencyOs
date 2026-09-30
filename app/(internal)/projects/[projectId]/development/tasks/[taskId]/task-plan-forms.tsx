'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { addSubtaskAction, setTaskLabelsAction } from '@/modules/projects/task-plan-actions';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/** "Add subtask" — the door of migration 20261004100000; the subtask starts as to do under this task. */
export function AddSubtaskForm({ projectId, parentTaskId, roster }: { projectId: string; parentTaskId: string; roster: { userId: string; fullName: string }[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: Parameters<typeof addSubtaskAction>[0], fd: FormData) => {
    const result = await addSubtaskAction(prev, fd);
    if (result.status === 'success') setOpen(false);
    return result;
  }, IDLE_STATE);
  const titleId = useId();
  const dueId = useId();
  const whoId = useId();
  if (!open) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen(true)} className="text-[13px] font-medium text-brand hover:underline">+ Add subtask</button>
        <FormMessage status={state.status} message={state.message} />
      </span>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="parentTaskId" value={parentTaskId} />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1">
          <label htmlFor={titleId} className={labelClass}>Subtask</label>
          <input id={titleId} name="title" required maxLength={200} className={inputClass} placeholder="Implement banner carousel" autoFocus />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={dueId} className={labelClass}>Due date</label>
          <input id={dueId} name="dueOn" type="date" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={whoId} className={labelClass}>Assignee</label>
          <select id={whoId} name="assigneeId" defaultValue="" className={selectClass}>
            <option value="">Unassigned</option>
            {roster.map((p) => (
              <option key={p.userId} value={p.userId}>{p.fullName}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>{pending ? 'Adding…' : 'Add subtask'}</button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>Cancel</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/** The task's labels as one comma-separated field — the set_task_labels door trims, de-duplicates and bounds them. */
export function LabelsForm({ projectId, taskId, labels }: { projectId: string; taskId: string; labels: string[] }) {
  const [state, action, pending] = useActionState(setTaskLabelsAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <label htmlFor={id} className={labelClass}>Labels</label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} name="labels" defaultValue={labels.join(', ')} maxLength={220} placeholder="Feature, Backend" className={`${inputClass} min-w-0 flex-1`} />
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Save labels'}</button>
      </div>
      <p className="text-[11px] text-muted">Up to eight, separated by commas; each up to 24 characters.</p>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
