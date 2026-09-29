'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { createTaskAction } from '@/modules/projects/actions';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-019 — "Create task" in place on the overview. The same
 * `createTaskAction` the Development page and the Board use, opened
 * inline so the overview is not a page of links to other pages.
 */
export function QuickTaskForm({ projectId, modules }: { projectId: string; modules: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(createTaskAction, IDLE_STATE);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('primary', 'sm')}>
        + Task
      </button>
    );
  }
  return (
    <form action={action} className="flex w-full flex-col gap-2 rounded-lg border border-line bg-canvas p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={labelClass}>Title</span>
          <input name="title" required maxLength={200} className={inputClass} autoFocus />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Due</span>
          <input name="dueOn" type="date" className={inputClass} />
        </label>
        {modules.length > 0 ? (
          <label className="flex flex-col gap-1 sm:col-span-3">
            <span className={labelClass}>Module</span>
            <select name="moduleId" defaultValue="" className={selectClass}>
              <option value="">No module</option>
              {modules.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Creating…' : 'Create task'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
