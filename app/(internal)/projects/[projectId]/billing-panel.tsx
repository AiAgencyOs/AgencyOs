'use client';

import { useActionState } from 'react';

import { generateMilestoneInvoiceAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';

const button =
  'rounded-lg border border-black/15 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10';

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
        <span role="status" className="text-xs text-red-600 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
