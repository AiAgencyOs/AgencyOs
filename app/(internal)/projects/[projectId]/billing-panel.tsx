'use client';

import { useActionState } from 'react';

import { generateMilestoneInvoiceAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

const button = buttonClass('secondary', 'sm');

/**
 * Raises the draft invoice for one milestone.
 *
 * One form per row rather than a single form with a selected milestone: the
 * action a user wants is always "invoice *this* one", and making them pick
 * from a list they are already looking at is a step that only exists to serve
 * the implementation.
 *
 * The button does not disable itself after submitting to prevent a second
 * click. It does not need to — generating twice returns the first invoice, and
 * the message says as much. Correctness lives in the service and the unique
 * index, not in whether the browser managed to grey a button in time.
 */
export function GenerateInvoiceButton({
  milestoneId,
  projectId,
}: {
  milestoneId: string;
  projectId: string;
}) {
  const [state, action, pending] = useActionState(generateMilestoneInvoiceAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={button}>
        {pending ? 'Drafting…' : 'Generate draft'}
      </button>
      {state.status === 'error' ? (
        <span role="status" className="text-xs text-danger">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
