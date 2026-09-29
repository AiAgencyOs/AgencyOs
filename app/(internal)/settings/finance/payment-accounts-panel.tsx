'use client';

import { useActionState, useState } from 'react';

import { createPaymentAccountAction, setPaymentAccountStatusAction } from '@/modules/finance/actions';
import {
  PAYMENT_ACCOUNT_FIELDS,
  PAYMENT_ACCOUNT_KIND_LABEL,
  PAYMENT_ACCOUNT_KINDS,
  type PaymentAccountKind,
} from '@/modules/finance/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, inputClass, labelClass, selectClass } from '@/ui';

function Message({ status, message }: { status: string; message?: string }) {
  if (status === 'idle' || !message) return null;
  return <span className={`text-xs ${status === 'error' ? 'text-danger' : 'text-success'}`}>{message}</span>;
}

/**
 * SCR-057 — add a receiving account (Doc 15 §9). The instruction fields
 * follow the kind chosen, so a bank account asks for an IFSC and a UPI
 * account for a VPA; the JSON the database keeps holds only what was typed.
 */
export function AddPaymentAccountForm() {
  const [state, action, pending] = useActionState(createPaymentAccountAction, IDLE_STATE);
  const [kind, setKind] = useState<PaymentAccountKind>('bank');

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Kind</span>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as PaymentAccountKind)} className={selectClass}>
            {PAYMENT_ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>{PAYMENT_ACCOUNT_KIND_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Label</span>
          <input name="label" required maxLength={120} placeholder="HDFC current account" className={inputClass} />
        </label>
        {PAYMENT_ACCOUNT_FIELDS[kind].map((field) => (
          <label key={field.key} className="flex flex-col gap-1">
            <span className={labelClass}>{field.label}</span>
            <input name={`field_${field.key}`} maxLength={500} className={inputClass} />
          </label>
        ))}
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Effective from</span>
          <input type="date" name="effectiveFrom" className={inputClass} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Adding…' : 'Add receiving account'}
        </button>
        <Message status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function PaymentAccountStatusButton({ accountId, status }: { accountId: string; status: 'active' | 'inactive' }) {
  const [state, action, pending] = useActionState(setPaymentAccountStatusAction, IDLE_STATE);
  const next = status === 'active' ? 'inactive' : 'active';

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="status" value={next} />
      <button type="submit" disabled={pending} className={buttonClass(next === 'inactive' ? 'danger' : 'secondary', 'sm')}>
        {pending ? 'Saving…' : next === 'inactive' ? 'Deactivate' : 'Reactivate'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}
