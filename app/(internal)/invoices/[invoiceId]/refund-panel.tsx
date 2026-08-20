'use client';

import { useActionState } from 'react';

import { recordRefundAction, requestRefundAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, inputClass } from '@/ui';

/**
 * Asking for a refund, and recording that one left — gap G-005.
 *
 * Two forms, and the gap between them is the point. Asking raises an approval
 * and moves no money; recording says the transfer happened. A single control
 * that did both would be a refund with no approval, which is the one thing
 * `finance.refunds` exists to prevent, and no UI convenience is worth
 * reopening it.
 *
 * Neither form checks whether the approval was granted. The database refuses
 * an unapproved recording, and a check here would be a copy of that rule that
 * could drift from the one that actually runs — so the button is shown and the
 * refusal is surfaced as written.
 */

export function RequestRefundForm({
  invoiceId,
  availableMajor,
  currency,
}: {
  invoiceId: string;
  availableMajor: string;
  currency: string;
}) {
  const [state, action, pending] = useActionState(requestRefundAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />

      <label htmlFor="refund-amount" className="text-xs font-medium uppercase tracking-wide text-muted">
        Amount to refund ({currency}) — {availableMajor} available
      </label>
      <input
        id="refund-amount"
        name="amountMajor"
        inputMode="decimal"
        required
        placeholder={availableMajor}
        aria-invalid={state.fieldErrors?.['amountMajor'] ? true : undefined}
        className={inputClass}
      />
      {state.fieldErrors?.['amountMajor'] ? (
        <p className="text-sm text-danger">
          {state.fieldErrors['amountMajor'].join(' ')}
        </p>
      ) : null}

      <label htmlFor="refund-reason" className="text-xs font-medium uppercase tracking-wide text-muted">
        Why
      </label>
      <input
        id="refund-reason"
        name="reason"
        required
        maxLength={1000}
        placeholder="Client cancelled the second milestone"
        className={inputClass}
      />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className={buttonClass('secondary', 'sm', 'self-start')}
        >
          {pending ? 'Requesting…' : 'Request refund'}
        </button>

        {state.status !== 'idle' ? (
          <p
            role="status"
            className={`text-sm ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function RecordRefundForm({
  refundId,
  invoiceId,
}: {
  refundId: string;
  invoiceId: string;
}) {
  const [state, action, pending] = useActionState(recordRefundAction, IDLE_STATE);

  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="refundId" value={refundId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />

      <input
        name="providerRefundId"
        required
        minLength={3}
        placeholder="Bank or gateway reference"
        aria-label="Transfer reference"
        className={`${inputClass} min-w-56 flex-1`}
      />

      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Recording…' : 'Money has left'}
      </button>

      {state.status !== 'idle' ? (
        <p
          role="status"
          className={`w-full text-sm ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
