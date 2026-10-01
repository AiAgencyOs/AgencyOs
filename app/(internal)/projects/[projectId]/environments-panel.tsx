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
import { Badge, buttonClass, Card, FormMessage, humanize, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

import { DependencyStatusForm } from './builds/dependency-status-form';

/** SCR-043's environment/dependency forms and rows — thin client wrappers over the server actions. */

export function AddEnvironmentForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addEnvironmentAction, IDLE_STATE);

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Label</span>
            <input name="label" required maxLength={200} className={inputClass} placeholder="Staging" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Kind</span>
            <select name="kind" defaultValue="staging" className={selectClass}>
              {ENVIRONMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>URL</span>
          <input name="url" type="url" required maxLength={2000} className={inputClass} placeholder="https://staging.example.com" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Notes (optional)</span>
          <textarea name="notes" maxLength={1000} className={textareaClass} rows={2} />
        </label>
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
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Name</span>
            <input name="name" required maxLength={200} className={inputClass} placeholder="Next.js" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Version (optional)</span>
            <input name="version" maxLength={100} className={inputClass} placeholder="16.2.0" />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Reference link (optional)</span>
          <input name="reference" type="url" maxLength={2000} className={inputClass} placeholder="https://…/changelog" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Notes (optional)</span>
          <textarea name="notes" maxLength={1000} className={textareaClass} rows={2} />
        </label>
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
  /** `suppliedAtLabel` is the page's clock-formatted `suppliedAt`, since a client component has no clock. */
  dependency: ProjectDependency & { suppliedAtLabel?: string };
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
        <span className="flex items-center gap-2">
          {/* SCR-043: open until somebody marks it supplied or waived. */}
          <Badge tone={dependency.status === 'open' ? 'warning' : dependency.status === 'supplied' ? 'success' : 'neutral'}>{dependency.status}</Badge>
          {editable ? <RemoveDependencyButton projectId={projectId} dependencyId={dependency.id} /> : null}
        </span>
      </div>
      {dependency.notes ? <p className="mt-2 text-sm text-muted">{dependency.notes}</p> : null}
      {dependency.status !== 'open' ? (
        <p className="mt-1 text-xs text-muted">
          {humanize(dependency.status)}{dependency.suppliedAtLabel ? ` ${dependency.suppliedAtLabel}` : ''}{dependency.note ? ` — ${dependency.note}` : ''}
        </p>
      ) : null}
      {editable ? <DependencyStatusForm projectId={projectId} dependencyId={dependency.id} current={dependency.status} /> : null}
    </Card>
  );
}
