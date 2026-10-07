'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { markApprovalExecutedAction, markApprovalVerifiedAction } from '@/modules/approvals/p13-annotation-actions';
import { buttonClass, inputClass } from '@/ui';

/**
 * W7: after an approval, a person records that the approved action was carried out (mark executed) and then that someone checked it (mark verified).
 * The database refuses an out-of-order or unauthorized call; this only offers the right form at the right step.
 */
export function ApprovalExecutionForm({ requestId, step }: { requestId: string; step: 'execute' | 'verify' }) {
  const [state, action, pending] = useActionState(step === 'execute' ? markApprovalExecutedAction : markApprovalVerifiedAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="requestId" value={requestId} />
      <input name="note" type="text" placeholder="Note (optional)" className={inputClass} aria-label="Note" />
      <div>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : step === 'execute' ? 'Mark executed' : 'Mark verified'}
        </button>
      </div>
      {state.status !== 'idle' ? (
        <p role="status" className={`text-sm ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
