'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { cancelJobAction } from './cancel-actions';

/**
 * Cancel one queued job, with a reason — SCR-066.
 *
 * Drawn on queued rows only, because those are the only ones `core.cancel_job`
 * will accept; whether this caller may, and whether the job is still queued
 * by the time the click lands, are decided in `cancelJob` and under the
 * function's row lock. The reason is required: it is what the audit row
 * keeps, and a cancellation nobody explained is a job that vanished.
 */
export function CancelJobForm({ jobId, compact = false }: { jobId: string; compact?: boolean }) {
  const [state, action, pending] = useActionState(cancelJobAction, IDLE_STATE);

  return (
    <form action={action} className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'mt-1'}`}>
      <input type="hidden" name="jobId" value={jobId} />
      <input
        name="reason"
        required
        maxLength={500}
        placeholder="why cancel"
        aria-label="Reason for cancelling"
        className={`${inputClass} h-7 w-44 text-xs`}
      />
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
        {pending ? 'Cancelling…' : 'Cancel'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
