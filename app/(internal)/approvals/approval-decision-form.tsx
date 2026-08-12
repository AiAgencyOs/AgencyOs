'use client';

import { useActionState } from 'react';

import { decideApprovalAction } from '@/modules/approvals/actions';
import { IDLE_STATE } from '@/modules/identity/types';

/**
 * Approve, reject or send back one pending request.
 *
 * Three submit buttons on one form rather than three forms, so the pending
 * state disables all of them while a decision is in flight — two people
 * deciding at once is the case the engine locks against, and there is no
 * reason to let one person do it to themselves.
 *
 * **The buttons are drawn for everybody who can see the request.** Whether
 * this particular approver holds the required role is decided under a lock in
 * `approvals.decide_approval`, against the role snapshotted when the request
 * was raised. Hiding the button for a role that would be refused is a nicety;
 * showing it and surfacing the refusal is the honest failure, and it cannot go
 * stale the way a client-side copy of the rule can.
 *
 * `evidenceRef` appears only for a client-audience request, because that is
 * the only case the database requires it (ADM-08d): the client agreed on
 * WhatsApp, a staff member is recording it, and the row should say where to go
 * and read the client's own words.
 */
export function ApprovalDecisionForm({
  requestId,
  audience,
}: {
  requestId: string;
  audience: string;
}) {
  const [state, action, pending] = useActionState(decideApprovalAction, IDLE_STATE);

  const isClient = audience === 'client';

  return (
    <form action={action} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="requestId" value={requestId} />

      {isClient ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`evidence-${requestId}`} className="text-xs font-medium text-muted">
            Where the client agreed — required
          </label>
          <input
            id={`evidence-${requestId}`}
            name="evidenceRef"
            type="text"
            placeholder="WhatsApp message reference, or a link"
            aria-invalid={state.fieldErrors?.['evidenceRef'] ? true : undefined}
            className="rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
          />
          {state.fieldErrors?.['evidenceRef'] ? (
            <p className="text-sm text-red-600 dark:text-red-400">
              {state.fieldErrors['evidenceRef'].join(' ')}
            </p>
          ) : null}
        </div>
      ) : null}

      <input
        name="note"
        type="text"
        placeholder="Note (optional)"
        className="rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="decision"
          value="approved"
          disabled={pending}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          {pending ? 'Saving…' : 'Approve'}
        </button>
        <button
          type="submit"
          name="decision"
          value="changes_requested"
          disabled={pending}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          Request changes
        </button>
        <button
          type="submit"
          name="decision"
          value="rejected"
          disabled={pending}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          Reject
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
