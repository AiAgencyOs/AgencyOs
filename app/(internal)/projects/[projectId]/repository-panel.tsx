'use client';

import { useActionState } from 'react';

import { addRepositoryAction, removeRepositoryAction } from '@/modules/projects/actions';
import { REPOSITORY_PLATFORMS } from '@/modules/projects/schema';
import type { ProjectRepository } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Card, FormMessage, humanize, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/** SCR-042's add form and repository rows — thin client wrappers over the server actions. */

export function AddRepositoryForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addRepositoryAction, IDLE_STATE);

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Name</label>
            <input name="name" required maxLength={200} className={inputClass} placeholder="agencyos-web" />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Platform</label>
            <select name="platform" defaultValue="github" className={selectClass}>
              {REPOSITORY_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {humanize(p)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Repository link</label>
          <input name="url" type="url" required maxLength={2000} className={inputClass} placeholder="https://github.com/…" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Default branch (optional)</label>
            <input name="defaultBranch" maxLength={200} className={inputClass} placeholder="main" />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Code review link (optional)</label>
            <input name="reviewUrl" type="url" maxLength={2000} className={inputClass} placeholder="https://github.com/…/pulls" />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Notes (optional)</label>
          <textarea name="notes" maxLength={1000} className={textareaClass} rows={2} />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Adding…' : 'Add repository'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      </form>
    </Card>
  );
}

export function RemoveRepositoryButton({ projectId, repositoryId }: { projectId: string; repositoryId: string }) {
  const [state, action, pending] = useActionState(removeRepositoryAction, IDLE_STATE);

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {state.status === 'error' ? <span className="ml-2 text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function RepositoryCard({
  repo,
  projectId,
  editable,
}: {
  repo: ProjectRepository;
  projectId: string;
  editable: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            href={repo.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
          >
            {repo.name}
          </a>
          <span className="block text-xs text-muted">
            {humanize(repo.platform)}
            {repo.defaultBranch ? ` · ${repo.defaultBranch}` : ''}
          </span>
        </div>
        {editable ? <RemoveRepositoryButton projectId={projectId} repositoryId={repo.id} /> : null}
      </div>
      {repo.reviewUrl ? (
        <a
          href={repo.reviewUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-block text-xs underline underline-offset-2"
        >
          Code review
        </a>
      ) : null}
      {repo.notes ? <p className="mt-2 text-sm text-muted">{repo.notes}</p> : null}
    </Card>
  );
}
