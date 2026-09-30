'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import { addMyTaskAction } from '@/modules/projects/task-plan-actions';
import { buttonClass, FormMessage, IconPlus, inputClass, labelClass, selectClass } from '@/ui';

/** A column's "+ Add task": a task for me on a project I pick, born in this column's status, through the createTask and setTaskStatus doors. */
export function MyTaskAdd({ status, statusLabel, projects }: { status: 'todo' | 'in_progress' | 'in_review' | 'done'; statusLabel: string; projects: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: FormState, fd: FormData) => {
    const result = await addMyTaskAction(prev, fd);
    if (result.status === 'success') setOpen(false);
    return result;
  }, IDLE_STATE);
  const projectId = useId();
  const titleId = useId();
  const dueId = useId();

  if (projects.length === 0) return null;
  if (!open) {
    return (
      <div className="flex flex-col items-center gap-1 px-2 pb-2">
        <button type="button" onClick={() => setOpen(true)} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-brand transition-colors hover:bg-brand-soft">
          <IconPlus size={13} />
          Add task
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    );
  }
  return (
    <form action={action} className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
      <input type="hidden" name="status" value={status} />
      <div className="flex flex-col gap-1">
        <label htmlFor={projectId} className={labelClass}>Project</label>
        <select id={projectId} name="projectId" required defaultValue={projects[0]?.id} className={selectClass}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={titleId} className={labelClass}>Task ({statusLabel})</label>
        <input id={titleId} name="title" required maxLength={200} className={inputClass} autoFocus />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={dueId} className={labelClass}>Due date</label>
        <input id={dueId} name="dueOn" type="date" className={inputClass} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>{pending ? 'Adding…' : 'Add task'}</button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>Cancel</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
