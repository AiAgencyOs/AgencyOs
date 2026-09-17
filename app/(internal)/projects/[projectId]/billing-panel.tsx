'use client';

import { useActionState } from 'react';

import {
  confirmBillingModeAction,
  generateMilestoneInvoiceAction,
  issueFreeMaintenanceInvoiceAction,
  recordBillingDetailsAction,
} from '@/modules/finance/actions';
import type { ProjectBilling } from '@/modules/finance/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

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

/**
 * How this project is billed — Finance §4.1–§4.3, Master §5.6; G-275.
 *
 * G-255 recorded the mode, G-259 made every invoice refuse until one is
 * confirmed — and **neither door had a caller.** The refusal named an action
 * the product did not offer, so the first invoice raised after that gate
 * shipped would have been blocked by a message nobody could act on.
 *
 * **The choice is the client's, and the form says whose.** §4.1 asks whether
 * the client is billed with GST or without it; §4.3 forbids adding GST *"merely
 * because the agency has GST configuration."* So the source is recorded —
 * whether a client confirmed it or somebody here decided — and it is not
 * defaulted to the agency's own registration.
 *
 * **It does not compute tax.** `taxRateBpForMode` owns 18%, and a second copy
 * in a caption is a second thing to keep in step with the quotations that
 * promise it.
 */
export function BillingModeForm({
  projectId,
  billing,
}: {
  projectId: string;
  billing: ProjectBilling;
}) {
  const [state, action, pending] = useActionState(confirmBillingModeAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Billed</span>
        <select name="mode" required defaultValue={billing.mode ?? ''} className={inputClass}>
          <option value="" disabled>
            choose
          </option>
          <option value="gst">with GST</option>
          <option value="non_gst">without GST</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        {/*
          §4.3: a mode the agency assumed and a mode the client confirmed are
          different facts, and only one of them is safe to put on an invoice.
        */}
        <span className="text-xs text-muted">Who decided</span>
        <select name="source" defaultValue="client_confirmation" className={inputClass}>
          <option value="client_confirmation">the client confirmed it</option>
          <option value="internal">we decided internally</option>
        </select>
      </label>
      <label className="flex grow flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Note (optional)</span>
        <input name="note" className={inputClass} placeholder="confirmed on WhatsApp, 14 Sep" />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Recording…' : billing.mode ? 'Change the mode' : 'Confirm the billing mode'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function BillingDetailsForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(recordBillingDetailsAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Legal name</span>
        <input name="legalName" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">GSTIN</span>
        {/*
          Checked against its own checksum before the write (G-255), so a
          mistyped GSTIN is refused while the person who typed it is still
          looking at it rather than on the invoice it ends up printed on.
        */}
        <input name="gstin" className={`${inputClass} tabular`} placeholder="22AAAAA0000A1Z5" />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">State</span>
        <input name="billingState" className={inputClass} />
      </label>
      <label className="flex grow flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Billing address</span>
        <input name="billingAddress" className={inputClass} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Save billing details'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
