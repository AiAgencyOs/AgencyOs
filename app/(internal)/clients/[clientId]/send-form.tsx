'use client';

import { useActionState, useEffect, useRef } from 'react';

import { sendClientMessageFromClientAction } from '@/modules/crm/client-send-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, FormMessage, IconSend, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-017 — the composer on Client 360 › Communication. A thread picker over
 * the client's lead conversations, then the lead composer's own door. The
 * door decides the window and the consent; a refusal is shown as written,
 * because "sent" here means the client's phone, not a note.
 */
export function ClientSendForm({
  clientId,
  threads,
}: {
  clientId: string;
  threads: { conversationId: string; leadId: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(sendClientMessageFromClientAction, IDLE_STATE);
  const formRef = useRef<HTMLFormElement>(null);
  const leadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.status === 'success') formRef.current?.reset();
  }, [state]);

  if (threads.length === 0) {
    return <p className="text-[13px] text-muted">No lead thread to write to — a message needs a conversation the client has been part of.</p>;
  }

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <input ref={leadRef} type="hidden" name="leadId" defaultValue={threads[0]?.leadId ?? ''} />
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor="client-send-thread">
          Thread
        </label>
        <select
          id="client-send-thread"
          name="conversationId"
          defaultValue={threads[0]?.conversationId}
          className={cx(selectClass, 'w-auto max-w-full')}
          onChange={(e) => {
            const picked = threads.find((t) => t.conversationId === e.target.value);
            if (leadRef.current && picked) leadRef.current.value = picked.leadId;
          }}
        >
          {threads.map((t) => (
            <option key={t.conversationId} value={t.conversationId}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        name="body"
        required
        maxLength={4000}
        rows={3}
        placeholder="Message — this reaches the client's phone. WhatsApp carries free text only inside the 24-hour window; outside it, an approved template."
        className={textareaClass}
        aria-label="Message to the client"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          <IconSend size={14} />
          {pending ? 'Sending…' : 'Send to the client'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
