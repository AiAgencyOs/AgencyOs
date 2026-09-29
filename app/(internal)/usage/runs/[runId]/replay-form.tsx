'use client';

import { useActionState } from 'react';

import { replayRunAction } from '@/modules/agents/replay-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

/**
 * Replay a run — SCR-065. Drawn only for `read` work (the page asks
 * `mayReplay`), because a replay queues the job again and only read-only
 * tools can run twice without acting twice; the door holds the same rule.
 * The reason is required: it is what the audit row keeps.
 */
export function ReplayRunForm({ runId }: { runId: string }) {
  const [state, action, pending] = useActionState(replayRunAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="runId" value={runId} />
      <input name="reason" required maxLength={500} placeholder="why replay" aria-label="Reason for replaying" className={`${inputClass} h-8 w-44 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Queueing…' : 'Replay run'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}
