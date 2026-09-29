'use client';

import { useActionState } from 'react';

import { sendInvoiceEmailAction } from '@/modules/finance/email-send-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Callout, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-051 — send the bill (or a reminder) by email, with the PDF attached.
 * Drawn only when a transport is configured; otherwise the page shows the
 * transport's own words about what is missing, because a button that
 * cannot send is a button that lies.
 */
export function SendInvoiceEmailForm({
  invoiceId,
  defaultTo,
  defaultKind,
  transport,
}: {
  invoiceId: string;
  defaultTo: string | null;
  defaultKind: 'sent' | 'reminder';
  transport: { configured: true; label: string } | { configured: false; reason: string };
}) {
  const [state, action, pending] = useActionState(sendInvoiceEmailAction, IDLE_STATE);

  if (!transport.configured) {
    return (
      <Callout tone="info" title="Email is not configured">
        {transport.reason} Until then, open the PDF, send it yourself, and record the send below.
      </Callout>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <label htmlFor="email-to" className={labelClass}>Send by email to</label>
          <input id="email-to" name="to" type="email" required defaultValue={defaultTo ?? ''} placeholder="billing@client.example" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="email-kind" className={labelClass}>As</label>
          <select id="email-kind" name="kind" defaultValue={defaultKind} className={selectClass}>
            <option value="sent">the invoice</option>
            <option value="reminder">a reminder</option>
          </select>
        </div>
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Sending…' : 'Send with PDF attached'}
        </button>
      </div>
      <input name="note" maxLength={1000} placeholder="A line for the body (optional)" aria-label="Note" className={inputClass} />
      <p className="text-xs text-muted">Through {transport.label}. Recorded under Sent / reminders only once the provider accepts it.</p>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
