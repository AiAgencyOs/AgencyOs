'use client';

import { useActionState } from 'react';

import { recordRefundAction, requestRefundAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';

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
        className="rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />
      {state.fieldErrors?.['amountMajor'] ? (
        <p className="text-sm text-red-600 dark:text-red-400">
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
        className="rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          {pending ? 'Requesting…' : 'Request refund'}
        </button>

        {state.status !== 'idle' ? (
          <p
            role="status"
            className={`text-sm ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
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
        className="min-w-56 flex-1 rounded-lg border border-black/15 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
      >
        {pending ? 'Recording…' : 'Money has left'}
      </button>

      {state.status !== 'idle' ? (
        <p
          role="status"
          className={`w-full text-sm ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
