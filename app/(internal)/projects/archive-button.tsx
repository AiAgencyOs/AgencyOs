'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { archiveProjectAction } from '@/modules/projects/project-archive-actions';
import { buttonClass, FormMessage } from '@/ui';

/**
 * SCR-018 — "Archive completed project". Offered on a completed row only;
 * `projects.archive_project` refuses any other status, and that refusal
 * is shown verbatim here.
 */
export function ArchiveProjectButton({ projectId, projectName, compact }: { projectId: string; projectName: string; compact?: boolean }) {
  const [state, action, pending] = useActionState(archiveProjectAction, IDLE_STATE);
  return (
    <form
      action={action}
      className="inline-flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        if (!window.confirm(`Archive “${projectName}”? It stays readable under Archived; nothing is deleted.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={buttonClass(compact ? 'ghost' : 'secondary', 'sm')}>
        {pending ? 'Archiving…' : 'Archive'}
      </button>
      {state.status !== 'idle' ? <FormMessage status={state.status} message={state.message} /> : null}
    </form>
  );
}
