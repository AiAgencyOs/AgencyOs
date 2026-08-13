'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';

import { requeueJobAction } from './actions';

/**
 * Put one dead job back in the queue — G-099.
 *
 * The button is drawn for everybody who can see the page. Whether this caller
 * may requeue is decided in `requeueJob` against the capability model, and
 * whether the job is still dead is decided under a row lock in
 * `core.requeue_job` — the same reasoning the approval form is built on. A
 * client-side copy of either rule can go stale; a surfaced refusal cannot.
 *
 * The refusal is worth reading rather than dismissing. "That job is queued, so
 * there is nothing to revive" on a page that has been open for ten minutes
 * usually means a colleague got there first, which is not a failure and needs
 * nothing from the person reading it.
 */
export function RequeueForm({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(requeueJobAction, IDLE_STATE);

  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="jobId" value={jobId} />

      <button
        type="submit"
        disabled={pending}
        className="rounded border border-default px-2 py-1 text-xs font-medium hover:bg-subtle disabled:opacity-50"
      >
        {pending ? 'Requeueing…' : 'Requeue'}
      </button>

      {state.status !== 'idle' && state.message ? (
        <span
          className={`text-xs ${
            state.status === 'error'
              ? 'text-red-600 dark:text-red-400'
              : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
