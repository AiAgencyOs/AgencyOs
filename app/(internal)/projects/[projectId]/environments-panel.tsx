'use client';

import { useActionState } from 'react';

import {
  addDependencyAction,
  addEnvironmentAction,
  removeDependencyAction,
  removeEnvironmentAction,
} from '@/modules/projects/actions';
import { ENVIRONMENT_KINDS } from '@/modules/projects/schema';
import type { ProjectDependency, ProjectEnvironment } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Card, FormMessage, humanize, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/** SCR-043's environment/dependency forms and rows — thin client wrappers over the server actions. */

export function AddEnvironmentForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addEnvironmentAction, IDLE_STATE);

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Label</label>
            <input name="label" required maxLength={200} className={inputClass} placeholder="Staging" />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Kind</label>
            <select name="kind" defaultValue="staging" className={selectClass}>
              {ENVIRONMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>URL</label>
          <input name="url" type="url" required maxLength={2000} className={inputClass} placeholder="https://staging.example.com" />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Notes (optional)</label>
          <textarea name="notes" maxLength={1000} className={textareaClass} rows={2} />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Adding…' : 'Add environment'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      </form>
    </Card>
  );
}

export function RemoveEnvironmentButton({ projectId, environmentId }: { projectId: string; environmentId: string }) {
  const [state, action, pending] = useActionState(removeEnvironmentAction, IDLE_STATE);

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="environmentId" value={environmentId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {state.status === 'error' ? <span className="ml-2 text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function EnvironmentCard({
  environment,
  projectId,
  editable,
}: {
  environment: ProjectEnvironment;
  projectId: string;
  editable: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            href={environment.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
          >
            {environment.label}
          </a>
          <span className="block text-xs text-muted">{humanize(environment.kind)}</span>
        </div>
        {editable ? <RemoveEnvironmentButton projectId={projectId} environmentId={environment.id} /> : null}
      </div>
      {environment.notes ? <p className="mt-2 text-sm text-muted">{environment.notes}</p> : null}
    </Card>
  );
}

export function AddDependencyForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addDependencyAction, IDLE_STATE);

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Name</label>
            <input name="name" required maxLength={200} className={inputClass} placeholder="Next.js" />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Version (optional)</label>
            <input name="version" maxLength={100} className={inputClass} placeholder="16.2.0" />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Reference link (optional)</label>
          <input name="reference" type="url" maxLength={2000} className={inputClass} placeholder="https://…/changelog" />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Notes (optional)</label>
          <textarea name="notes" maxLength={1000} className={textareaClass} rows={2} />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Adding…' : 'Add dependency'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      </form>
    </Card>
  );
}

export function RemoveDependencyButton({ projectId, dependencyId }: { projectId: string; dependencyId: string }) {
  const [state, action, pending] = useActionState(removeDependencyAction, IDLE_STATE);

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="dependencyId" value={dependencyId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {state.status === 'error' ? <span className="ml-2 text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function DependencyCard({
  dependency,
  projectId,
  editable,
}: {
  dependency: ProjectDependency;
  projectId: string;
  editable: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {dependency.reference ? (
            <a
              href={dependency.reference}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
            >
              {dependency.name}
            </a>
          ) : (
            <span className="block truncate text-sm font-medium text-foreground">{dependency.name}</span>
          )}
          {dependency.version ? <span className="block text-xs text-muted">{dependency.version}</span> : null}
        </div>
        {editable ? <RemoveDependencyButton projectId={projectId} dependencyId={dependency.id} /> : null}
      </div>
      {dependency.notes ? <p className="mt-2 text-sm text-muted">{dependency.notes}</p> : null}
    </Card>
  );
}
