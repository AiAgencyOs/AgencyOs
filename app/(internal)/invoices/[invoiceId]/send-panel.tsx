'use client';

import { useActionState } from 'react';

import { recordInvoiceSendAction } from '@/modules/finance/sends-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

const CHANNELS: readonly { value: string; label: string }[] = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'manual', label: 'By hand / other' },
];

/**
 * "Record that it was sent" — SCR-051. Every word is chosen to keep this
 * honest: nothing here sends an invoice. There is no invoice WhatsApp door
 * in this product (the only document sender is the quotation's), so the
 * person sends the PDF themselves and writes it down here — and the same
 * for a reminder, which is the record the invoices list reads to say
 * "needs a reminder".
 */
export function RecordInvoiceSendForm({ invoiceId, defaultKind }: { invoiceId: string; defaultKind: 'sent' | 'reminder' }) {
  const [state, action, pending] = useActionState(recordInvoiceSendAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-dashed border-line p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>What happened</span>
          <select name="kind" defaultValue={defaultKind} className={selectClass} aria-label="Kind">
            <option value="sent">Invoice sent to the client</option>
            <option value="reminder">Reminder sent</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>On</span>
          <select name="channel" defaultValue="whatsapp" className={selectClass} aria-label="Channel">
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>When (blank = now)</span>
          <input name="sentAt" type="datetime-local" className={inputClass} aria-label="Sent at" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Message reference (optional)</span>
          <input name="messageRef" maxLength={200} className={`${inputClass} w-48`} placeholder="wamid… / email subject" />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Note (optional)</span>
        <input name="note" maxLength={600} className={inputClass} placeholder="Sent to Priya with the PDF attached" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Recording…' : 'Record that it was sent'}
        </button>
        <span className="text-xs text-muted">This writes down a send you made yourself. Nothing is sent from here.</span>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
