'use client';

import { useActionState } from 'react';

import { setTaskStatusAction } from '@/modules/projects/actions';
import { TASK_STATUSES } from '@/modules/projects/schema';
import type { MyTaskRow } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { selectClass } from '@/ui';

export function MyTaskStatusSelect({ task }: { task: MyTaskRow }) {
  const [state, action, pending] = useActionState(setTaskStatusAction, IDLE_STATE);

  return (
    <form action={action} className="inline-flex items-center gap-1">
      <input type="hidden" name="projectId" value={task.projectId} />
      <input type="hidden" name="taskId" value={task.id} />
      <select
        name="status"
        defaultValue={task.status}
        className={`${selectClass} py-1 text-xs`}
        disabled={pending}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.replace('_', ' ')}
          </option>
        ))}
      </select>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
