'use client';

import { useActionState } from 'react';

import { generateMilestoneInvoiceAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { markMilestoneMetAction } from '@/modules/projects/milestone-actions';
import { FormMessage, buttonClass } from '@/ui';

/**
 * SCR-023 — the two doors on a payment milestone from the plan page.
 *
 * "Mark met" writes `status = 'met', met_at = now()` through
 * `markMilestoneMet` (`milestone.write`, then RLS). "Generate invoice" is
 * the finance module's own `generateMilestoneInvoiceAction`, the door the
 * project page already opens; the plan page renders it only for the
 * milestone `listEligibleMilestones` says is next, so the service's refusal
 * — shown verbatim — is the exception, not the rule.
 */
export function MarkMilestoneMetForm({ projectId, milestoneId, label = 'Mark met' }: { projectId: string; milestoneId: string; label?: string }) {
  const [state, action, pending] = useActionState(markMilestoneMetAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Marking…' : label}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function TriggerFinanceMilestoneForm({ projectId, milestoneId }: { projectId: string; milestoneId: string }) {
  const [state, action, pending] = useActionState(generateMilestoneInvoiceAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Drafting…' : 'Trigger finance milestone'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
