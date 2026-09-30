'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { closeSprintAction, createSprintAction, placeTaskInSprintAction } from '@/modules/projects/sprint-actions';
import { SPRINT_LENGTH_CHOICES, SPRINT_LENGTH_MAX, SPRINT_LENGTH_MIN } from '@/modules/projects/sprint-schema';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/** "New sprint" — the create_sprint door of migration 20261005100000: a name, a first day and a fixed length in days. */
export function NewSprintForm({ projectId, defaultStart, suggestedName }: { projectId: string; defaultStart: string; suggestedName: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: Parameters<typeof createSprintAction>[0], fd: FormData) => {
    const result = await createSprintAction(prev, fd);
    if (result.status === 'success') setOpen(false);
    return result;
  }, IDLE_STATE);
  const nameId = useId();
  const startId = useId();
  const lengthId = useId();
  if (!open) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')}>New sprint</button>
        <FormMessage status={state.status} message={state.message} />
      </span>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className={labelClass}>Sprint name</label>
        <input id={nameId} name="name" required maxLength={80} defaultValue={suggestedName} className={inputClass} autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={startId} className={labelClass}>First day</label>
          <input id={startId} name="startsOn" type="date" required defaultValue={defaultStart} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={lengthId} className={labelClass}>Length (days)</label>
          <input id={lengthId} name="lengthDays" type="number" required min={SPRINT_LENGTH_MIN} max={SPRINT_LENGTH_MAX} step={1} defaultValue={SPRINT_LENGTH_CHOICES[1]} list={`${lengthId}-choices`} className={inputClass} />
          <datalist id={`${lengthId}-choices`}>
            {SPRINT_LENGTH_CHOICES.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>{pending ? 'Creating…' : 'Create sprint'}</button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>Cancel</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/** Closes a sprint; its tasks keep it. */
export function CloseSprintButton({ projectId, sprintId, name }: { projectId: string; sprintId: string; name: string }) {
  const [state, action, pending] = useActionState(closeSprintAction, IDLE_STATE);
  return (
    <form
      action={action}
      className="inline-flex items-center gap-1"
      onSubmit={(e) => {
        if (!window.confirm(`Close ${name}? Its tasks stay in it; no task can be placed in a closed sprint.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="sprintId" value={sprintId} />
      <button type="submit" disabled={pending} className="text-xs font-medium text-brand hover:underline">{pending ? 'Closing…' : 'Close'}</button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

/** The task page's Sprint: pick one of the project's open sprints, or take the task out. */
export function PlaceInSprintForm({ projectId, taskId, current, sprints }: { projectId: string; taskId: string; current: string | null; sprints: { id: string; name: string; closed: boolean }[] }) {
  const [state, action, pending] = useActionState(placeTaskInSprintAction, IDLE_STATE);
  const id = useId();
  const choices = sprints.filter((s) => !s.closed || s.id === current);
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <label htmlFor={id} className={labelClass}>Sprint</label>
      <div className="flex flex-wrap items-center gap-2">
        <select id={id} name="sprintId" defaultValue={current ?? ''} className={`${selectClass} min-w-0 flex-1`}>
          <option value="">No sprint</option>
          {choices.map((s) => (
            <option key={s.id} value={s.id}>{s.name}{s.closed ? ' (closed)' : ''}</option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Save sprint'}</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
