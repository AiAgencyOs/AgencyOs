'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { cancelRunningJobAction } from './cancel-running-actions';

/**
 * Ask a RUNNING job to stop — SCR-065/066. Drawn on running rows only; the
 * flag it sets is honoured by the runner between steps, so the honest label
 * is "stop at next step", not "stop now". The reason is required: it is
 * what the audit row keeps.
 */
export function CancelRunningJobForm({ jobId, compact = false }: { jobId: string; compact?: boolean }) {
  const [state, action, pending] = useActionState(cancelRunningJobAction, IDLE_STATE);

  return (
    <form action={action} className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'mt-1'}`}>
      <input type="hidden" name="jobId" value={jobId} />
      <input name="reason" required maxLength={500} placeholder="why stop it" aria-label="Reason for stopping" className={`${inputClass} h-7 w-44 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
        {pending ? 'Asking…' : 'Stop at next step'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
