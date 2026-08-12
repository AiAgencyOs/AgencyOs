'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import {
  appendMessageAction,
  requestExtractionAction,
  sendClientMessageAction,
} from '@/modules/crm/actions';

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
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="leadId" value={leadId} />

      <label className="text-xs font-medium uppercase tracking-wide text-muted" htmlFor="send-body">
        Send to the client on WhatsApp
      </label>
      <textarea
        id="send-body"
        name="body"
        rows={3}
        required
        maxLength={4000}
        placeholder="This reaches the client's phone."
        className="rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          {pending ? 'Sending…' : 'Send'}
        </button>

        {state.status !== 'idle' ? (
          <p
            role="status"
            className={`text-sm ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function MessageForm({
  conversationId,
  leadId,
}: {
  conversationId: string;
  leadId: string;
}) {
  const [state, action, pending] = useActionState(appendMessageAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="leadId" value={leadId} />

      <label className="text-xs font-medium uppercase tracking-wide text-muted" htmlFor="body">
        Add to transcript
      </label>
      <textarea
        id="body"
        name="body"
        rows={3}
        required
        placeholder="What did the customer say?"
        className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
      />

      <div className="flex flex-wrap items-center gap-3">
        <select
          name="authorType"
          defaultValue="client"
          aria-label="Who said this"
          className="rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
        >
          <option value="client">Customer</option>
          <option value="user">Staff</option>
        </select>

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          {pending ? 'Adding…' : 'Add message'}
        </button>
      </div>

      {state.status !== 'idle' ? (
        <p
          role="status"
          className={`text-sm ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
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
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
      >
        {pending ? 'Queueing…' : 'Extract requirements'}
      </button>
      {state.status !== 'idle' ? (
        <p
          role="status"
          className={`text-sm ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
