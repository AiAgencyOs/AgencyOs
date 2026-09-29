'use client';

import { useActionState } from 'react';

import {
  addReconciliationItemAction,
  closeReconciliationAction,
  openReconciliationAction,
  resolveReconciliationItemAction,
} from '@/modules/finance/reconciliation-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * The reconciliation forms — Doc 15 §15 and §29, gap row 053. Four acts and
 * nothing else: open a period against a statement, enter its lines by hand
 * (there is no bank import — no gateway, no format), work the exception
 * queue with a reason, close. None of them touches a payment; matching
 * writes a pointer, and the payment it points at stays exactly as it was.
 */

const FINDINGS: readonly { value: string; label: string }[] = [
  { value: 'unmatched', label: 'Unmatched — no payment found yet' },
  { value: 'matched', label: 'Matched — names a recorded payment' },
  { value: 'duplicate', label: 'Duplicate — the same money twice' },
  { value: 'missing', label: 'Missing — recorded here, not on the statement' },
  { value: 'discrepant', label: 'Discrepant — amounts disagree' },
];

export type PaymentOption = { id: string; label: string };

export function OpenReconciliationForm({ accounts }: { accounts: readonly { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState(openReconciliationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-dashed border-line p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>From</span>
          <input name="periodStart" type="date" required className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>To (exclusive)</span>
          <input name="periodEnd" type="date" required className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Account</span>
          <select name="accountId" defaultValue="" className={selectClass}>
            <option value="">No particular account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-64 flex-1 flex-col gap-1">
          <span className={labelClass}>Statement (source)</span>
          <input name="source" required maxLength={200} className={inputClass} placeholder="HDFC current account statement, Sep 2026" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Opening…' : 'Open a reconciliation'}
        </button>
        <span className="text-xs text-muted">One open period per account. Nothing here alters a payment.</span>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function AddReconciliationItemForm({ reconciliationId, payments }: { reconciliationId: string; payments: readonly PaymentOption[] }) {
  const [state, action, pending] = useActionState(addReconciliationItemAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-dashed border-line p-4">
      <input type="hidden" name="reconciliationId" value={reconciliationId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Statement line, exactly as the bank printed it</span>
        <input name="statementLine" required maxLength={500} className={`${inputClass} font-mono text-xs`} placeholder="10/09/2026  NEFT CR  ACME RETAIL PVT LTD  45,000.00" />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Statement date</span>
          <input name="statementDate" type="date" required className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Amount (our reading)</span>
          <input name="amount" required inputMode="decimal" className={`${inputClass} w-32`} placeholder="45000.00" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Reference</span>
          <input name="reference" maxLength={200} className={`${inputClass} w-40`} placeholder="NEFT-8891" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Finding</span>
          <select name="finding" defaultValue="unmatched" className={selectClass}>
            {FINDINGS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Payment (for a match)</span>
          <select name="paymentId" defaultValue="" className={selectClass}>
            <option value="">—</option>
            {payments.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Reason (required before the period can close, for anything but a match)</span>
        <input name="reason" maxLength={600} className={inputClass} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Recording…' : 'Record this line'}
        </button>
        <span className="text-xs text-muted">The line is frozen once written; only the finding and reason can change.</span>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ResolveReconciliationItemForm({
  itemId,
  finding,
  paymentId,
  reason,
  proposedPaymentId,
  payments,
}: {
  itemId: string;
  finding: string;
  paymentId: string | null;
  reason: string | null;
  proposedPaymentId: string | null;
  payments: readonly PaymentOption[];
}) {
  const [state, action, pending] = useActionState(resolveReconciliationItemAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="itemId" value={itemId} />
      <select name="finding" defaultValue={finding} className={selectClass} aria-label="Finding">
        {FINDINGS.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>
      <select name="paymentId" defaultValue={paymentId ?? proposedPaymentId ?? ''} className={`${selectClass} max-w-64`} aria-label="Payment">
        <option value="">— no payment —</option>
        {payments.map((p) => (
          <option key={p.id} value={p.id}>{p.label}{p.id === proposedPaymentId && !paymentId ? ' (proposed)' : ''}</option>
        ))}
      </select>
      <input name="reason" maxLength={600} defaultValue={reason ?? ''} className={`${inputClass} w-64`} placeholder="Reason" aria-label="Reason" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function CloseReconciliationForm({ reconciliationId, unresolved }: { reconciliationId: string; unresolved: number }) {
  const [state, action, pending] = useActionState(closeReconciliationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="reconciliationId" value={reconciliationId} />
      <button type="submit" disabled={pending} className={buttonClass(unresolved > 0 ? 'secondary' : 'primary', 'sm')}>
        {pending ? 'Closing…' : 'Close this period'}
      </button>
      <span className="text-xs text-muted">
        {unresolved > 0
          ? `${unresolved} line${unresolved === 1 ? '' : 's'} still unexplained — the close will be refused until each has a reason.`
          : 'Every line is matched or explained.'}
      </span>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
