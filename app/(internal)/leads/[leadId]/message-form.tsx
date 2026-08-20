'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import {
  appendMessageAction,
  requestExtractionAction,
  sendClientMessageAction,
} from '@/modules/crm/actions';
import {
  buttonClass,
  FormMessage,
  IconSend,
  IconSparkle,
  selectClass,
  textareaClass,
} from '@/ui';

/**
 * The two write controls for a conversation. Client components because they
 * report action state; the actions themselves re-check auth server-side.
 */

/**
 * Send a message to the client over WhatsApp — gap G-014, decision ADM-09.
 *
 * Deliberately a separate form from "Add to transcript" rather than a checkbox
 * on it. One of these writes a note; the other reaches a customer's phone, and
 * a control that does both depending on a tickbox is how somebody sends an
 * internal note to a client at eleven at night.
 *
 * The redesign keeps that separation and makes it visible: this one is the
 * composer at the foot of the chat, in WhatsApp's green, where a message to a
 * person belongs. The transcript note is a collapsed grey control above it.
 * They no longer look alike, which is a stronger guard than the labels were.
 *
 * The row is written before the send, so a failure here leaves a visible
 * attempt in the transcript with the reason attached, rather than nothing.
 */
export function SendToClientForm({
  conversationId,
  leadId,
}: {
  conversationId: string;
  leadId: string;
}) {
  const [state, action, pending] = useActionState(sendClientMessageAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="leadId" value={leadId} />

      <label className="sr-only" htmlFor="send-body">
        Send to the client on WhatsApp
      </label>

      <div className="flex items-end gap-2">
        <textarea
          id="send-body"
          name="body"
          rows={1}
          required
          maxLength={4000}
          placeholder="Message — this reaches the client's phone"
          className="max-h-32 min-h-11 flex-1 resize-none rounded-3xl border border-transparent bg-surface px-4 py-3 text-[15px] leading-tight text-foreground outline-none transition-colors placeholder:text-faint focus:border-[var(--wa-header)]"
        />
        <button
          type="submit"
          disabled={pending}
          aria-label={pending ? 'Sending' : 'Send to the client on WhatsApp'}
          title="Send to the client on WhatsApp"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--wa-accent)] text-[var(--wa-accent-fg)] shadow-sm transition-transform hover:brightness-95 active:scale-95 disabled:opacity-50"
        >
          <IconSend size={19} className={pending ? 'animate-pulse' : undefined} />
        </button>
      </div>

      <FormMessage status={state.status} message={state.message} className="px-1" />
    </form>
  );
}

/**
 * Record something that was said somewhere this system was not — a phone call,
 * a corridor conversation. Collapsed by default and deliberately plain: it
 * writes to the transcript and reaches nobody.
 */
export function MessageForm({
  conversationId,
  leadId,
}: {
  conversationId: string;
  leadId: string;
}) {
  const [state, action, pending] = useActionState(appendMessageAction, IDLE_STATE);

  return (
    <details className="group mb-2 rounded-lg border border-[var(--wa-divider)] bg-surface/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:text-foreground">
        <span className="text-base leading-none transition-transform group-open:rotate-45">+</span>
        Add to transcript — recorded here only, sends nothing
      </summary>

      <form action={action} className="flex flex-col gap-2 border-t border-[var(--wa-divider)] p-3">
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="leadId" value={leadId} />

        <label className="sr-only" htmlFor="body">
          Add to transcript
        </label>
        <textarea
          id="body"
          name="body"
          rows={2}
          required
          placeholder="What did the customer say?"
          className={textareaClass}
        />

        <div className="flex flex-wrap items-center gap-2">
          <select
            name="authorType"
            defaultValue="client"
            aria-label="Who said this"
            className={`${selectClass} w-auto min-w-32`}
          >
            <option value="client">Customer</option>
            <option value="user">Staff</option>
          </select>

          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Adding…' : 'Add message'}
          </button>
        </div>

        <FormMessage status={state.status} message={state.message} />
      </form>
    </details>
  );
}

export function ExtractionForm({
  conversationId,
  leadId,
}: {
  conversationId: string;
  leadId: string;
}) {
  const [state, action, pending] = useActionState(requestExtractionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="leadId" value={leadId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        <IconSparkle size={15} />
        {pending ? 'Queueing…' : 'Extract requirements'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
