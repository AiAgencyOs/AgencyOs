'use client';

import { useActionState } from 'react';

import {
  createFeatureAction,
  createModuleAction,
  createTaskAction,
  setFeatureStatusAction,
  setModuleStatusAction,
  setTaskStatusAction,
} from '@/modules/projects/actions';
import { FEATURE_STATUSES, MODULE_STATUSES, TASK_STATUSES } from '@/modules/projects/schema';
import type { DevelopmentFeature, DevelopmentModule, DevelopmentTask } from '@/modules/projects/queries';
import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * Phase 5 development breakdown — modules, features and tasks (SCR-039/040
 * combined into one screen for now; a full implementation-plan / task-board
 * split can follow once this has real usage to design from). The schema and
 * RLS predate this panel by a month; this is the first reader or writer
 * either table has had anywhere in the application.
 */

function StatusForm({
  action,
  hiddenName,
  hiddenValue,
  status,
  options,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  hiddenName: string;
  hiddenValue: string;
  status: string;
  options: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(action, IDLE_STATE);

  return (
    <form action={formAction} className="inline-flex items-center gap-1">
      <input type="hidden" name={hiddenName} value={hiddenValue} />
      <select
        name="status"
        defaultValue={status}
        className={`${selectClass} py-1 text-xs`}
        disabled={pending}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace('_', ' ')}
          </option>
        ))}
      </select>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

function TaskRow({ task }: { task: DevelopmentTask }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{task.title}</span>
        <span className="text-xs text-muted">{task.priority}</span>
      </span>
      <StatusForm
        action={setTaskStatusAction}
        hiddenName="taskId"
        hiddenValue={task.id}
        status={task.status}
        options={TASK_STATUSES}
      />
    </li>
  );
}

function AddTaskForm({ projectId, moduleId, features }: { projectId: string; moduleId: string; features: DevelopmentFeature[] }) {
  const [state, action, pending] = useActionState(createTaskAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="moduleId" value={moduleId} />
      <div className="flex min-w-40 flex-1 flex-col gap-1">
        <label className={labelClass}>Task</label>
        <input name="title" required maxLength={200} className={inputClass} placeholder="Build the login form" />
      </div>
      {features.length > 0 ? (
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Feature</label>
          <select name="featureId" className={selectClass} defaultValue="">
            <option value="">none</option>
            {features.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Adding…' : 'Add task'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function AddFeatureForm({ projectId, moduleId }: { projectId: string; moduleId: string }) {
  const [state, action, pending] = useActionState(createFeatureAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="moduleId" value={moduleId} />
      <div className="flex min-w-40 flex-1 flex-col gap-1">
        <label className={labelClass}>Feature</label>
        <input name="name" required maxLength={200} className={inputClass} placeholder="OTP login" />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Adding…' : 'Add feature'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ModuleCard({
  module,
  features,
  tasks,
  projectId,
}: {
  module: DevelopmentModule;
  features: DevelopmentFeature[];
  tasks: DevelopmentTask[];
  projectId: string;
}) {
  const done = tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{module.name}</h3>
          {module.description ? <p className="mt-0.5 text-xs text-muted">{module.description}</p> : null}
          {tasks.length > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {done} of {tasks.length} task{tasks.length === 1 ? '' : 's'} done
            </p>
          ) : null}
        </div>
        <StatusForm
          action={setModuleStatusAction}
          hiddenName="moduleId"
          hiddenValue={module.id}
          status={module.status}
          options={MODULE_STATUSES}
        />
      </div>

      {features.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {features.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="font-medium">{f.name}</span>
              <StatusForm
                action={setFeatureStatusAction}
                hiddenName="featureId"
                hiddenValue={f.id}
                status={f.status}
                options={FEATURE_STATUSES}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {tasks.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <AddFeatureForm projectId={projectId} moduleId={module.id} />
      </div>
      <AddTaskForm projectId={projectId} moduleId={module.id} features={features} />
    </div>
  );
}

export function AddModuleForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(createModuleAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-line p-4">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label className={labelClass}>New module</label>
        <input name="name" required maxLength={200} className={inputClass} placeholder="Authentication" />
      </div>
      <div className="flex min-w-48 flex-[2] flex-col gap-1">
        <label className={labelClass}>Description (optional)</label>
        <input name="description" maxLength={4000} className={inputClass} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Adding…' : 'Add module'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function UnassignedTasks({ projectId, tasks }: { projectId: string; tasks: DevelopmentTask[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold">Unassigned to a module</h3>
      {tasks.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">Nothing here yet.</p>
      )}
      <AddTaskFormNoModule projectId={projectId} />
    </div>
  );
}

function AddTaskFormNoModule({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(createTaskAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex min-w-40 flex-1 flex-col gap-1">
        <label className={labelClass}>Task</label>
        <input name="title" required maxLength={200} className={inputClass} placeholder="Set up CI" />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Adding…' : 'Add task'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
