'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { handleMeetingFlagAction } from './actions';

export function HandleFlagForm({ flagId }: { flagId: string }) {
  const [state, action, pending] = useActionState(handleMeetingFlagAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="flagId" value={flagId} />
      <input name="note" required maxLength={1000} placeholder="what you did" aria-label="What you did about it" className={`${inputClass} h-7 w-56 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Mark handled'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
