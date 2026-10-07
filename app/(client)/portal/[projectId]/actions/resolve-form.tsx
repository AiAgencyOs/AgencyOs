'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, textareaClass } from '@/ui';

import { resolveClientActionAction } from './actions';

/** Tell the agency you did what was asked. It is a message, not a confirmation: a person at the agency checks it. Please never type a password or key here. */
export function ResolveClientActionForm({ projectId, requestId }: { projectId: string; requestId: string }) {
  const [state, action, pending] = useActionState(resolveClientActionAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="requestId" value={requestId} />
      <label className="flex flex-col gap-1 text-sm">
        <span>What did you do?</span>
        <textarea name="note" rows={2} required className={textareaClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>A link or reference, if you have one (optional; never a password)</span>
        <input name="reference" type="text" className={textareaClass} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('primary')}>
        {pending ? 'Sending...' : 'I have done this'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
