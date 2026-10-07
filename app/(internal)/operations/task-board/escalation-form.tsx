'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { resolveEscalationAction } from './actions';

export function ResolveEscalationForm({ escalationId }: { escalationId: string }) {
  const [state, action, pending] = useActionState(resolveEscalationAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="escalationId" value={escalationId} />
      <input name="note" required maxLength={2000} placeholder="what was decided" aria-label="What was decided" className={`${inputClass} h-7 w-64 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Resolve'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
