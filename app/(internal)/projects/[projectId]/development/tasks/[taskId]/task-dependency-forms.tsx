'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { addTaskDependencyAction, removeTaskDependencyAction } from '@/modules/projects/task-dependency-actions';
import { buttonClass, FormMessage, labelClass, selectClass } from '@/ui';

/** R2-1 — "this task waits for…": pick a task of the project. The door refuses a loop or another project. */
export function AddDependencyForm({ projectId, taskId, candidates }: { projectId: string; taskId: string; candidates: { id: string; title: string; status: string }[] }) {
  const [state, action, pending] = useActionState(addTaskDependencyAction, IDLE_STATE);
  const pickId = useId();
  if (candidates.length === 0) return <p className="text-[13px] text-muted">No other task on this project can be added.</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={pickId} className={labelClass}>This task waits for</label>
        <select id={pickId} name="dependsOnTaskId" required defaultValue="" className={selectClass}>
          <option value="" disabled>Choose a task…</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>{t.title} ({t.status.replace(/_/g, ' ')})</option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Adding…' : 'Add dependency'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function RemoveDependencyForm({ projectId, taskId, dependsOnTaskId }: { projectId: string; taskId: string; dependsOnTaskId: string }) {
  const [state, action, pending] = useActionState(removeTaskDependencyAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="dependsOnTaskId" value={dependsOnTaskId} />
      <button type="submit" disabled={pending} className="text-[13px] font-medium text-danger hover:underline">{pending ? 'Removing…' : 'Remove'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
