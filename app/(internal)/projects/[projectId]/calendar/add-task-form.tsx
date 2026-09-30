'use client';

import { useActionState, useState } from 'react';

import { createTaskAction } from '@/modules/projects/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-022 — "create a task on this day". The same `createTaskAction` the
 * Development page uses, with `dueOn` pre-filled from the day clicked; the
 * schema carries the date through to `projects.tasks.due_on` in the same
 * insert, so the task never exists without its day.
 */
export function AddTaskOnDayForm({
  projectId,
  dueOn,
  modules,
  compact,
}: {
  projectId: string;
  dueOn: string;
  modules: { id: string; name: string }[];
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(createTaskAction, IDLE_STATE);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={compact ? 'text-xs text-muted hover:text-foreground' : buttonClass('ghost', 'sm')}
        aria-label={`Add a task due ${dueOn}`}
      >
        + task
      </button>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2 text-left">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="dueOn" value={dueOn} />
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Task due {dueOn}</label>
        <input name="title" required maxLength={200} className={inputClass} placeholder="What has to be done" autoFocus />
      </div>
      {modules.length > 0 ? (
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Module</label>
          <select name="moduleId" className={selectClass} defaultValue="">
            <option value="">none</option>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Adding…' : 'Add task'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
