'use client';

import { useActionState, useState } from 'react';

import { setTaskStatusAction } from '@/modules/projects/actions';
import { TASK_STATUSES } from '@/modules/projects/schema';
import type { MyTaskRow } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, selectClass } from '@/ui';

import { BlockReasonField } from '../task-collab-panel';

/**
 * The status control on a My Tasks card. Choosing Blocked does not submit
 * by itself: the reason field appears and the move is one submit carrying
 * both — `setTaskStatus` refuses a Blocked without one (SCR-021).
 */
export function MyTaskStatusSelect({ task }: { task: MyTaskRow }) {
  const [state, action, pending] = useActionState(setTaskStatusAction, IDLE_STATE);
  const [blocking, setBlocking] = useState(false);

  return (
    <form action={action} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="projectId" value={task.projectId} />
      <input type="hidden" name="taskId" value={task.id} />
      <select
        name="status"
        defaultValue={task.status}
        className={`${selectClass} py-1 text-xs`}
        disabled={pending}
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
            {s.replace('_', ' ')}
          </option>
        ))}
      </select>
      {blocking ? (
        <>
          <BlockReasonField taskId={`card-${task.id}`} />
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Blocking…' : 'Mark blocked'}
          </button>
        </>
      ) : null}
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
