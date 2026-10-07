'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { cancelQuotationAction, recordAcceptanceAction } from './actions';

export function AcceptanceForm({ proposals, contacts }: { proposals: Array<{ id: string; version: number; label: string }>; contacts: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(recordAcceptanceAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">Quotation the client accepted
        <select name="proposalId" required className={`${inputClass} h-9`}>{proposals.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Version the client named
        <input name="statedVersion" inputMode="numeric" placeholder="leave empty if they did not say" className={`${inputClass} h-9`} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Who accepted
        <select name="contactId" required className={`${inputClass} h-9`}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Where it came from
        <select name="channel" required className={`${inputClass} h-9`}>
          <option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="portal">Portal</option><option value="other">Other</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Evidence (message reference, recording, signed reply)
        <input name="evidenceRef" required maxLength={500} className={`${inputClass} h-9`} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Message id (optional)<input name="messageRef" maxLength={200} className={`${inputClass} h-9`} /></label>
      <label className="flex flex-col gap-1 text-sm">Note (optional)<input name="note" maxLength={500} className={`${inputClass} h-9`} /></label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'md')}>{pending ? 'Recording…' : 'Record acceptance'}</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function CancelForm({ proposalId }: { proposalId: string }) {
  const [state, action, pending] = useActionState(cancelQuotationAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="proposalId" value={proposalId} />
      <input name="reason" required maxLength={500} placeholder="why cancel" aria-label="Reason for cancelling" className={`${inputClass} h-7 w-48 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>{pending ? 'Cancelling…' : 'Cancel quotation'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
