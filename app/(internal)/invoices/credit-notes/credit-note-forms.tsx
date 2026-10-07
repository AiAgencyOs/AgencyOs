'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { issueCreditNoteAction, linkReplacementAction, requestCreditNoteAction } from './actions';

export function RequestCreditNoteForm({ invoices }: { invoices: Array<{ id: string; label: string }> }) {
  const [state, action, pending] = useActionState(requestCreditNoteAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Invoice
        <select name="invoiceId" required className={`${inputClass} h-9`}>{invoices.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Amount credited (rupees)<input name="amount" required inputMode="decimal" placeholder="1500.00" className={`${inputClass} h-9`} /></label>
      <label className="flex flex-col gap-1 text-sm">Of which tax (rupees)<input name="tax" inputMode="decimal" placeholder="0" className={`${inputClass} h-9`} /></label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Reason (printed on the record)<input name="reason" required minLength={3} maxLength={1000} className={`${inputClass} h-9`} /></label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'md')}>{pending ? 'Requesting…' : 'Request credit note'}</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function IssueCreditNoteForm({ creditNoteId }: { creditNoteId: string }) {
  const [state, action, pending] = useActionState(issueCreditNoteAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="creditNoteId" value={creditNoteId} />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>{pending ? 'Issuing…' : 'Issue'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function LinkReplacementForm({ creditNoteId, invoices }: { creditNoteId: string; invoices: Array<{ id: string; label: string }> }) {
  const [state, action, pending] = useActionState(linkReplacementAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="creditNoteId" value={creditNoteId} />
      <select name="invoiceId" aria-label="Replacement invoice" className={`${inputClass} h-7 text-xs`}>{invoices.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Linking…' : 'Link replacement'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
