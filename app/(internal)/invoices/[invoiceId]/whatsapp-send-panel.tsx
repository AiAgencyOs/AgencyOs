'use client';

import { useActionState } from 'react';

import { sendInvoiceWhatsAppAction } from '@/modules/finance/whatsapp-send-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, IconSend, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * "Send on WhatsApp" — SCR-051, owner decision 2026-09-29 (reverses the
 * "records only" stance of 20260929160000). The invoice text and its PDF go
 * through the quotation's own governed door, so consent, the 24-hour window
 * and the provider decide; a refusal is shown as written. The record row is
 * written by the door after the send, not by this form.
 */
export function SendInvoiceWhatsAppForm({
  invoiceId,
  threads,
  configured,
}: {
  invoiceId: string;
  threads: { conversationId: string; kind: string; label: string }[];
  /** Whether this deployment can send at all (token set, number registered). */
  configured: { ok: true } | { ok: false; reason: string };
}) {
  const [state, action, pending] = useActionState(sendInvoiceWhatsAppAction, IDLE_STATE);

  if (!configured.ok) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4 text-[13px] text-muted">
        <span className="font-medium text-foreground">Send on WhatsApp is not available:</span> {configured.reason}
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4 text-[13px] text-muted">
        <span className="font-medium text-foreground">No WhatsApp thread to send on.</span> This client has no thread of its own, the project has no group and no lead thread belongs to the client. Link one first, or send the PDF yourself and record it below.
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-64 flex-col gap-1">
          <span className={labelClass}>Thread</span>
          <select name="conversationId" defaultValue={threads[0]?.conversationId} className={selectClass} aria-label="Thread">
            {threads.map((t) => (
              <option key={t.conversationId} value={t.conversationId}>{t.label}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className={labelClass}>Note for the record (optional)</span>
          <input name="note" maxLength={600} className={inputClass} placeholder="Sent after the call with Priya" />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('whatsapp', 'sm')}>
          <IconSend size={15} />
          {pending ? 'Sending…' : 'Send on WhatsApp'}
        </button>
      </div>
      <p className="text-xs text-muted">
        The invoice text goes first, then the PDF. Consent and the 24-hour window are checked on the way; a refusal is shown here as written, and nothing is recorded unless the text reached the client.
      </p>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
