'use client';

import { useActionState } from 'react';

import { unwatchProjectAction, watchProjectAction } from '@/modules/projects/project-defaults-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, IconBell } from '@/ui';

/**
 * SCR-027 — "Watch this project" on the overview header. One click writes
 * the caller's own `project_watchers` row (every phase); which phases, and
 * anyone else's watch, are set on the Settings tab.
 */
export function WatchProjectButton({ projectId, watching }: { projectId: string; watching: boolean }) {
  const [state, action, pending] = useActionState(watching ? unwatchProjectAction : watchProjectAction, IDLE_STATE);

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
        title={watching ? 'Stop hearing about phase changes on this project' : 'Hear about phase changes on this project in your Action Center'}
      >
        <IconBell size={14} />
        {pending ? 'Saving…' : watching ? 'Watching' : 'Watch this project'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
