'use client';

import { useActionState } from 'react';

import {
  confirmBankLineMatchAction,
  ignoreBankLineAction,
  importBankStatementAction,
} from '@/modules/finance/bank-import-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * The bank CSV import and its two resolutions — SCR-053, owner decision
 * 2026-09-29. Upload a statement (date, description, amount, reference),
 * accept a proposed match, or set a line aside with a reason. Each is one
 * audited door; none touches a payment.
 */

export type BankMatchOption = { id: string; label: string };

export function ImportBankStatementForm({ reconciliationId }: { reconciliationId: string }) {
  const [state, action, pending] = useActionState(importBankStatementAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-dashed border-line p-4">
      <input type="hidden" name="reconciliationId" value={reconciliationId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Bank statement (CSV)</span>
          <input name="file" type="file" accept=".csv,text/csv" required className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-canvas file:px-2 file:py-1 file:text-xs`} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Reading…' : 'Import statement'}
        </button>
      </div>
      <span className="text-xs text-muted">
        Columns by header name, any order: <code className="text-[11px]">date, description, amount, reference</code> (or credit / debit columns). Lines are kept verbatim; matches are only proposed until you confirm one.
      </span>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ConfirmBankLineMatchForm({
  lineId,
  proposedPaymentId,
  payments,
}: {
  lineId: string;
  proposedPaymentId: string | null;
  payments: readonly BankMatchOption[];
}) {
  const [state, action, pending] = useActionState(confirmBankLineMatchAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="lineId" value={lineId} />
      <select name="paymentId" defaultValue={proposedPaymentId ?? ''} required className={`${selectClass} max-w-72`} aria-label="Payment">
        <option value="" disabled>
          — choose the payment —
        </option>
        {payments.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.id === proposedPaymentId ? ' (proposed)' : ''}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending || payments.length === 0} className={buttonClass('primary', 'sm')}>
        {pending ? 'Matching…' : 'Confirm match'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function IgnoreBankLineForm({ lineId }: { lineId: string }) {
  const [state, action, pending] = useActionState(ignoreBankLineAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="lineId" value={lineId} />
      <input name="reason" required maxLength={600} className={`${inputClass} w-56`} placeholder="Why it is set aside" aria-label="Reason" />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Saving…' : 'Set aside'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
