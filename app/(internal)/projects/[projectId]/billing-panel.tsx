'use client';

import { useActionState } from 'react';

import {
  generateMilestoneInvoiceAction,
  issueFreeMaintenanceInvoiceAction,
} from '@/modules/finance/actions';
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

/**
 * Finance §9 — the ₹0 invoice for maintenance that was included, not sold.
 *
 * Here rather than on a maintenance page, because there is no maintenance page:
 * `projects.maintenance_plans` has been a database-only feature since G-034's
 * correction. This is the one action §9 asks for, put beside the payment
 * ladder G-268 shows, which is where somebody is already looking when a
 * project reaches 100%.
 *
 * Two sentences the button has to carry, because both look like mistakes
 * otherwise. **Nothing is owed and nobody verifies it** — not a bypass of
 * ADM-04, but the same rule at zero. And **AgencyOS does not send it**: §9
 * asks for the invoice to reach the client's email and the project WhatsApp
 * group, and this deployment has neither channel (BLK-007, BLK-003).
 */
export function FreeMaintenanceInvoiceButton({
  planId,
  projectId,
  name,
  endsOn,
  invoiceNumber,
}: {
  planId: string;
  projectId: string;
  name: string;
  endsOn: string | null;
  invoiceNumber: string | null;
}) {
  const [state, action, pending] = useActionState(issueFreeMaintenanceInvoiceAction, IDLE_STATE);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{name}</span>
        <span className="text-muted">free maintenance{endsOn ? ` to ${endsOn}` : ''}</span>
      </span>
      {invoiceNumber ? (
        <span className="text-muted">
          <span className="tabular">{invoiceNumber}</span> raised at ₹0 — send it yourself
        </span>
      ) : (
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="planId" value={planId} />
          <input type="hidden" name="projectId" value={projectId} />
          <button type="submit" disabled={pending} className={button}>
            {pending ? 'Raising…' : 'Raise the ₹0 invoice'}
          </button>
          {state.status === 'error' ? (
            <span className="text-danger">{state.message}</span>
          ) : null}
          {state.status === 'success' ? (
            <span className="text-muted">{state.message}</span>
          ) : null}
        </form>
      )}
    </div>
  );
}
