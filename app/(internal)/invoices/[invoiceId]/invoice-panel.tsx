'use client';

import { useActionState } from 'react';

import {
  issueInvoiceAction,
  recordManualPaymentAction,
  verifyPaymentAction,
  voidInvoiceAction,
} from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

const input = inputClass;
const button = buttonClass('secondary', 'sm');

/**
 * Labels for the payment methods the server offers.
 *
 * The vocabulary itself is passed in from the page rather than imported here:
 * `finance/schema.ts` carries Zod, and pulling a validation library into the
 * browser to render five `<option>` elements is a poor trade. The list still
 * has exactly one definition — this component just receives it.
 */
const METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cheque: 'Cheque',
  cash: 'Cash',
  other: 'Other',
};

function Status({ state }: { state: { status: string; message?: string } }) {
  return <FormMessage status={state.status} message={state.message} />;
}

/**
 * Issues a draft.
 *
 * Labelled as sending because that is what it does: the invoices RLS policy
 * shows a client every invoice on their account that is not a draft, so
 * leaving draft is the moment the client can see the bill. There is no second
 * "send" step to forget, and no messaging integration is implied by this
 * button — when one exists it will subscribe to the `invoice.issued` event.
 */
export function IssueInvoiceForm({
  invoiceId,
  projectId,
  dueOn,
}: {
  invoiceId: string;
  projectId: string | null;
  dueOn: string | null;
}) {
  const [state, action, pending] = useActionState(issueInvoiceAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Due date
          <input name="dueOn" type="date" defaultValue={dueOn ?? ''} className={`${input} w-44`} aria-label="Due date" />
        </label>
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Issuing…' : 'Issue & share with client'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}

/**
 * Records money that has already arrived.
 *
 * Every word here is chosen to keep the manual mechanism honest. This form
 * does not collect a payment, request one, or contact a provider — it writes
 * down a receipt somebody has already seen, with the bank reference as the
 * evidence. The reference is also the idempotency key, so submitting the same
 * receipt twice is refused rather than double-counted.
 */
export function RecordPaymentForm({
  invoiceId,
  projectId,
  outstandingMajor,
  currency,
  methods,
}: {
  invoiceId: string;
  projectId: string | null;
  outstandingMajor: string;
  currency: string;
  methods: readonly string[];
}) {
  const [state, action, pending] = useActionState(recordManualPaymentAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Amount received ({currency})
          <input
            name="amountMajor"
            defaultValue={outstandingMajor}
            inputMode="decimal"
            placeholder="45000.00"
            className={`${input} w-40`}
          aria-label="Amount" />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          How
          <select name="method" defaultValue={methods[0]} className={`${input} w-40`} aria-label="Payment method">
            {methods.map((method) => (
              <option key={method} value={method}>
                {METHOD_LABELS[method] ?? method}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Reference (UTR, UPI id, cheque no.)
          <input name="reference" required placeholder="UTR2026080912345" className={`${input} w-64`} aria-label="Payment reference" />
        </label>

        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Recording…' : 'Record payment received'}
        </button>
      </div>

      <p className="text-xs text-muted">
        This records money you have already received. Nothing is charged and no payment provider is
        contacted.
      </p>

      <Status state={state} />
    </form>
  );
}

/** Withdraws an invoice, freeing its milestone to be invoiced again. */
export function VoidInvoiceForm({
  invoiceId,
  projectId,
}: {
  invoiceId: string;
  projectId: string | null;
}) {
  const [state, action, pending] = useActionState(voidInvoiceAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Reason
          <input
            name="reason"
            required
            placeholder="Raised against the wrong milestone"
            className={`${input} w-72`}
          aria-label="Reason for voiding" />
        </label>
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Voiding…' : 'Void invoice'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}

/**
 * Confirms one recorded payment against the bank — ADM-04, G-007; G-270.
 *
 * `finance.verify_payment` and `verifyPayment` were both written in August,
 * both tested, and **nothing ever called either of them**. Since G-007 made
 * `status = 'paid'` follow confirmed money rather than recorded money, that
 * meant no invoice in this system could ever become paid: money could be
 * written down and nobody could say they had seen it arrive. Everything that
 * waits on a paid invoice — ADM-13's advance gate, the milestone unlock, the
 * Phase 7 100% gate — was waiting on an act the product did not offer.
 *
 * One form per payment, like the invoice buttons above and for the same
 * reason: the act is always "confirm *this* receipt", checked against a line
 * on a statement.
 *
 * The button does not disable itself to stop a second click. Two people
 * reading the same statement do not fight — `verify_payment` decides under the
 * invoice's row lock and gives the second one the same answer.
 */
export function VerifyPaymentButton({
  paymentId,
  invoiceId,
  projectId,
}: {
  paymentId: string;
  invoiceId: string;
  projectId: string | null;
}) {
  const [state, action, pending] = useActionState(verifyPaymentAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Confirming…' : 'I have seen this on the statement'}
      </button>
      {state.status === 'error' ? (
        <span className="text-[13px] text-danger">{state.message}</span>
      ) : null}
      {state.status === 'success' ? (
        <span className="text-[13px] text-muted">{state.message}</span>
      ) : null}
    </form>
  );
}
