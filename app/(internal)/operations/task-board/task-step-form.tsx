'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { advanceTaskAction } from './actions';

/** P1-COORD-017: record the NEXT step on the task line. The database refuses a leap, a step the task's status does not allow, and (for verifying and closing) anyone who is not a signed-in administrator. */
export function TaskStepForm({ handoffId, toState, label }: { handoffId: string; toState: string; label: string }) {
  const [state, action, pending] = useActionState(advanceTaskAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="handoffId" value={handoffId} />
      <input type="hidden" name="toState" value={toState} />
      <input name="note" maxLength={500} placeholder="note (optional)" aria-label="Note for this step" className={`${inputClass} h-7 w-56 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : `Record: ${label}`}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
