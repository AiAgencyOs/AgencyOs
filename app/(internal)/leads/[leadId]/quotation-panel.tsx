'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';
import {
  addProposalItemAction,
  draftProposalAction,
  recordProposalResponseAction,
  sendProposalAction,
  setProposalPricingAction,
  submitProposalAction,
} from '@/modules/sales/actions';

/**
 * The quotation loop, as a human walks it — G-011, ADM-07.
 *
 * Staff draft, the owner approves, then it is sent, and the client's answer is
 * recorded separately. Every control here maps to one Postgres function that
 * refuses the same thing under a row lock; nothing is hidden because the UI is
 * the gate, and nothing is offered because the UI forgot to hide it.
 *
 * The panel shows the version history Document 09 §16 asks for — superseded
 * versions stay visible, because "V1 remains historical" is only true if
 * somebody can still read V1.
 */

/**
 * The controls take their appearance from the design system rather than from
 * class strings copied per file, so a change to what an input looks like lands
 * everywhere at once. Kept as local aliases because the markup below already
 * reads `className={input}` in forty places.
 */
const input = inputClass;
const button = buttonClass('secondary', 'sm');
const label = labelClass;

function Status({ state }: { state: { status: string; message?: string } }) {
  return <FormMessage status={state.status} message={state.message} />;
}

export function DraftQuotationForm({
  leadId,
  opportunityId,
  defaultTitle,
  supersedes,
}: {
  leadId: string;
  opportunityId: string;
  defaultTitle: string;
  /** The version this draft would supersede, if one is live (§16). */
  supersedes: number | null;
}) {
  const [state, action, pending] = useActionState(draftProposalAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="opportunityId" value={opportunityId} />

      <label className={label} htmlFor="quotation-title">
        Quotation title
      </label>
      <input
        id="quotation-title"
        name="title"
        required
        maxLength={200}
        defaultValue={defaultTitle}
        className={input}
      />

      <label className={label} htmlFor="quotation-valid">
        Valid until
      </label>
      <input id="quotation-valid" name="validUntil" type="date" className={input} />

      <label className={label} htmlFor="quotation-body">
        Scope summary
      </label>
      <textarea id="quotation-body" name="body" rows={3} maxLength={20000} className={input} />

      <button type="submit" disabled={pending} className={button}>
        {supersedes === null ? 'Draft quotation' : `Draft a new version (supersedes v${supersedes})`}
      </button>
      <Status state={state} />
    </form>
  );
}

export function QuotationLineForm({ leadId, proposalId }: { leadId: string; proposalId: string }) {
  const [state, action, pending] = useActionState(addProposalItemAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="proposalId" value={proposalId} />

      <div className="flex flex-wrap gap-2">
        <input
          name="description"
          required
          maxLength={500}
          placeholder="What this line is for"
          className={`${input} flex-1 min-w-40`}
        aria-label="Line description" />
        <input
          name="quantity"
          type="number"
          step="0.01"
          min="0.01"
          defaultValue="1"
          aria-label="Quantity"
          className={`${input} w-24`}
        />
        <input
          name="unitPrice"
          type="number"
          step="0.01"
          min="0"
          placeholder="Unit price"
          aria-label="Unit price"
          className={`${input} w-32`}
        />
      </div>

      <button type="submit" disabled={pending} className={button}>
        Add line
      </button>
      <Status state={state} />
    </form>
  );
}

export function QuotationPricingForm({
  leadId,
  proposalId,
  discountMinor,
  taxMinor,
}: {
  leadId: string;
  proposalId: string;
  discountMinor: number;
  taxMinor: number;
}) {
  const [state, action, pending] = useActionState(setProposalPricingAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="proposalId" value={proposalId} />

      <div className="flex flex-wrap gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <label className={label} htmlFor="quotation-discount">
            Discount
          </label>
          <input
            id="quotation-discount"
            name="discount"
            type="number"
            step="0.01"
            min="0"
            defaultValue={(discountMinor / 100).toFixed(2)}
            className={input}
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label className={label} htmlFor="quotation-tax">
            Tax
          </label>
          <input
            id="quotation-tax"
            name="tax"
            type="number"
            step="0.01"
            min="0"
            defaultValue={(taxMinor / 100).toFixed(2)}
            className={input}
          />
        </div>
      </div>

      <button type="submit" disabled={pending} className={button}>
        Update pricing
      </button>
      <Status state={state} />
    </form>
  );
}

export function SubmitQuotationForm({
  leadId,
  proposalId,
}: {
  leadId: string;
  proposalId: string;
}) {
  const [state, action, pending] = useActionState(submitProposalAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="proposalId" value={proposalId} />

      <button type="submit" disabled={pending} className={button}>
        Send to the owner for approval
      </button>
      <p className="text-xs text-muted">
        A quotation carries a price, so the owner approves it before it reaches the client.
      </p>
      <Status state={state} />
    </form>
  );
}

export function SendQuotationForm({
  leadId,
  proposalId,
  conversationId,
}: {
  leadId: string;
  proposalId: string;
  conversationId: string | null;
}) {
  const [state, action, pending] = useActionState(sendProposalAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="proposalId" value={proposalId} />
      {conversationId ? (
        <input type="hidden" name="conversationId" value={conversationId} />
      ) : null}

      {/* The label said "Mark as sent" and meant it: this button recorded that
          somebody had sent the quotation themselves. It sends it now. The
          reference field stays, because a quotation that genuinely went by
          another route — emailed, handed over in a meeting — is still a send
          worth recording, and naming it skips the WhatsApp message. */}
      <label className={label} htmlFor="quotation-ref">
        Sent another way? (optional)
      </label>
      <input
        id="quotation-ref"
        name="messageRef"
        maxLength={200}
        placeholder="Leave empty to send it on WhatsApp now"
        className={input}
      />

      <button type="submit" disabled={pending} className={button}>
        {pending ? 'Sending…' : 'Send to the client'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function QuotationResponseForm({
  leadId,
  proposalId,
  lapsed,
}: {
  leadId: string;
  proposalId: string;
  /** Past its validity date — acceptance will be refused (§15). */
  lapsed: boolean;
}) {
  const [state, action, pending] = useActionState(recordProposalResponseAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="proposalId" value={proposalId} />

      <label className={label} htmlFor="quotation-response">
        What the client said
      </label>
      <select id="quotation-response" name="response" className={input} defaultValue="accepted">
        <option value="accepted">Accepted</option>
        <option value="rejected">Rejected</option>
      </select>

      <label className={label} htmlFor="quotation-note">
        Where they said it
      </label>
      <input
        id="quotation-note"
        name="note"
        maxLength={2000}
        placeholder="The message or call this came from"
        className={input}
      />

      {lapsed ? (
        <p className="text-sm text-muted">
          This quotation is past its validity date. It can still be recorded as rejected; accepting
          it needs a new version.
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={button}>
        Record the response
      </button>
      <p className="text-xs text-muted">
        Delivering a quotation is not the same as the client accepting it.
      </p>
      <Status state={state} />
    </form>
  );
}
