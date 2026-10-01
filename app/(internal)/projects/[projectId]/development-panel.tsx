'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import {
  createFeatureAction,
  createModuleAction,
  createTaskAction,
  setFeatureStatusAction,
  setModuleStatusAction,
  setTaskStatusAction,
} from '@/modules/projects/actions';
import { PROJECT_ROLE_LABEL, PROJECT_ROLES } from '@/modules/projects/project-members-schema';
import { FEATURE_STATUSES, MODULE_STATUSES, TASK_STATUSES } from '@/modules/projects/schema';
import { isCountedTask, selectableStatuses } from '@/modules/projects/task-transitions';
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
        aria-label="Status"
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

function TaskRow({ task, projectId }: { task: DevelopmentTask; projectId: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
      <span className="flex flex-wrap items-baseline gap-2">
        {/* SCR-041 — the title opens the task's own surface. */}
        <Link href={`/projects/${projectId}/development/tasks/${task.id}`} className="font-medium underline-offset-2 hover:underline">
          {task.title}
        </Link>
        <span className="text-xs text-muted">{task.priority}</span>
      </span>
      <StatusForm
        action={setTaskStatusAction}
        hiddenName="taskId"
        hiddenValue={task.id}
        status={task.status}
        options={selectableStatuses(TASK_STATUSES, task.status)}
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
      <label className="flex min-w-40 flex-1 flex-col gap-1">
        <span className={labelClass}>Task</span>
        <input name="title" required maxLength={200} className={inputClass} placeholder="Build the login form" />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>For project role</span>
        <select name="assigneeRole" className={selectClass} defaultValue="">
          <option value="">none</option>
          {PROJECT_ROLES.map((r) => (
            <option key={r} value={r}>
              {PROJECT_ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      {features.length > 0 ? (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Feature</span>
          <select name="featureId" className={selectClass} defaultValue="">
            <option value="">none</option>
            {features.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
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
      <label className="flex min-w-40 flex-1 flex-col gap-1">
        <span className={labelClass}>Feature</span>
        <input name="name" required maxLength={200} className={inputClass} placeholder="OTP login" />
      </label>
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
  // T1-1: a cancelled or archived task is listed but is not outstanding work, so it is not in "x of y done".
  const counted = tasks.filter(isCountedTask);
  const done = counted.filter((t) => t.status === 'done').length;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{module.name}</h3>
          {module.description ? <p className="mt-0.5 text-xs text-muted">{module.description}</p> : null}
          {counted.length > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {done} of {counted.length} task{counted.length === 1 ? '' : 's'} done
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
            <TaskRow key={t.id} task={t} projectId={projectId} />
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
      <label className="flex min-w-48 flex-1 flex-col gap-1">
        <span className={labelClass}>New module</span>
        <input name="name" required maxLength={200} className={inputClass} placeholder="Authentication" />
      </label>
      <label className="flex min-w-48 flex-[2] flex-col gap-1">
        <span className={labelClass}>Description (optional)</span>
        <input name="description" maxLength={4000} className={inputClass} />
      </label>
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
            <TaskRow key={t.id} task={t} projectId={projectId} />
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
      <label className="flex min-w-40 flex-1 flex-col gap-1">
        <span className={labelClass}>Task</span>
        <input name="title" required maxLength={200} className={inputClass} placeholder="Set up CI" />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Adding…' : 'Add task'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
