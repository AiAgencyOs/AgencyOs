'use client';

import { useActionState, useRef } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

import { requeueJobsAction } from './actions';
import { RequeueForm } from './requeue-form';

export type DeadLetterJob = {
  id: string;
  kind: string;
  attempts: number;
  maxAttempts: number;
  updatedAtDisplay: string;
  lastError: string | null;
};

const BULK_FORM_ID = 'bulk-requeue-form';

/**
 * Dead letters, with a "requeue selected" alongside the existing one-at-a-time
 * button — the page-5 shared rule for bulk actions on a list. Each checkbox
 * carries `form={BULK_FORM_ID}` rather than living inside a `<form>` element,
 * so it submits into the bulk form (declared once, above the list) without
 * nesting it inside each row's own solo `RequeueForm` — HTML forbids nested
 * `<form>`s, and the two need to stay independent: selecting a row for the
 * batch should not disable its own one-click requeue.
 */
export function DeadLettersList({ jobs, canRequeue }: { jobs: DeadLetterJob[]; canRequeue: boolean }) {
  const [state, action, pending] = useActionState(requeueJobsAction, IDLE_STATE);
  const listRef = useRef<HTMLUListElement>(null);

  function selectAll(checked: boolean) {
    listRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => {
      box.checked = checked;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {canRequeue ? (
        <form
          id={BULK_FORM_ID}
          action={action}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface/50 px-3 py-2"
        >
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <input
              type="checkbox"
              aria-label="Select all dead jobs"
              onChange={(e) => selectAll(e.target.checked)}
            />
            Select all
          </label>
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Requeueing…' : 'Requeue selected'}
          </button>
          {state.status !== 'idle' && state.message ? (
            <span className={`text-xs ${state.status === 'error' ? 'text-danger' : 'text-success'}`}>
              {state.message}
            </span>
          ) : null}
        </form>
      ) : null}

      <ul ref={listRef} className="flex flex-col gap-2">
        {jobs.map((job) => (
          <li key={job.id} className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 font-medium">
                {canRequeue ? (
                  <input
                    type="checkbox"
                    name="jobId"
                    value={job.id}
                    form={BULK_FORM_ID}
                    aria-label={`Select ${job.kind} for bulk requeue`}
                  />
                ) : null}
                {job.kind}
              </span>
              <span className="text-xs text-muted">
                {job.attempts}/{job.maxAttempts} attempts · {job.updatedAtDisplay}
              </span>
            </div>
            <p className="mt-1 break-words text-muted">
              {job.lastError ?? 'No error was recorded, which is itself worth investigating.'}
            </p>
            {canRequeue ? <RequeueForm jobId={job.id} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
