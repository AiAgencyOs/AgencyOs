'use client';

import { useActionState } from 'react';

import { linkRepositoryAction, unlinkRepositoryAction } from '@/modules/projects/repository-link-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Card, FormMessage, inputClass, labelClass } from '@/ui';

/**
 * The link/unlink controls for the live GitHub read — Decision: reversed by
 * the owner on 2026-09-29. Thin wrappers over the server actions; every
 * refusal is shown verbatim.
 */

export function LinkRepositoryForm({
  projectId,
  current,
}: {
  projectId: string;
  /** The link as it stands, so re-linking starts from it. */
  current: { owner: string; repo: string; defaultBranch: string } | null;
}) {
  const [state, action, pending] = useActionState(linkRepositoryAction, IDLE_STATE);

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-1">
            <label className={labelClass}>GitHub repository</label>
            <input
              name="repository"
              required
              maxLength={300}
              className={inputClass}
              placeholder="owner/name or https://github.com/owner/name"
              defaultValue={current ? `${current.owner}/${current.repo}` : ''}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Branch to read</label>
            <input
              name="defaultBranch"
              maxLength={200}
              className={inputClass}
              placeholder="main"
              defaultValue={current?.defaultBranch ?? ''}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Linking…' : current ? 'Change link' : 'Link repository'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
        <p className="text-xs text-muted">
          Only the link is stored. Commits and pull requests are read from GitHub each time this page loads; nothing
          is ever written to GitHub.
        </p>
      </form>
    </Card>
  );
}

export function UnlinkRepositoryButton({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(unlinkRepositoryAction, IDLE_STATE);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Unlinking…' : 'Unlink'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
