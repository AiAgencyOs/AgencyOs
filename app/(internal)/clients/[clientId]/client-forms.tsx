'use client';

import { useActionState } from 'react';

import { generateMilestoneInvoiceAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass } from '@/ui';

/**
 * SCR-016 — "generate invoice from approved milestone", from the client page.
 * The same door the project page's `GenerateInvoiceButton` opens
 * (`generateMilestoneInvoiceAction` → `generateInvoiceFromMilestone`), so the
 * service re-checks `invoice.create`, the milestone's invoiceability and the
 * deliverable gate exactly as it would from there. Nothing here decides
 * eligibility; the page only renders this for the milestone
 * `listEligibleMilestones` says is next.
 */
export function GenerateClientInvoiceButton({
  milestoneId,
  projectId,
  label,
}: {
  milestoneId: string;
  projectId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState(generateMilestoneInvoiceAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Drafting…' : label}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
