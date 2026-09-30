'use client';

import { useActionState } from 'react';

import { describeWorkflowCancel, type WorkflowCancelPlan } from '@/lib/observability/cancel-workflow-plan';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { cancelWorkflowAction } from './cancel-workflow-actions';

/**
 * Cancel a workflow — SCR-066. One reason, applied to every job of the chain
 * that has not settled: queued work is cancelled, running work is asked to
 * stop at its next step. The plan is computed on the server and only
 * described here.
 */
export function CancelWorkflowForm({ correlationId, plan }: { correlationId: string; plan: WorkflowCancelPlan }) {
  const [state, action, pending] = useActionState(cancelWorkflowAction, IDLE_STATE);
  const nothing = plan.cancel.length === 0 && plan.stop.length === 0;

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">Cancel workflow</p>
      <p className="text-xs text-muted">{nothing ? 'Every job in this workflow has settled; there is nothing to cancel.' : `This will ${describeWorkflowCancel(plan)}.`}</p>
      <input type="hidden" name="correlationId" value={correlationId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="reason" required maxLength={500} disabled={nothing} placeholder="why cancel the workflow" aria-label="Reason for cancelling the workflow" className={`${inputClass} h-8 min-w-0 flex-1 text-xs`} />
        <button type="submit" disabled={pending || nothing} className={buttonClass('danger', 'sm')}>
          {pending ? 'Cancelling…' : 'Cancel workflow'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
