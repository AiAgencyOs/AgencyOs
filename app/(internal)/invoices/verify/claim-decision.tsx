'use client';

import { useActionState, useId } from 'react';

import { decideClaimAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * The queue's decision — PDF SCR-054: PAYMENT VERIFIED, REJECT / NEED MORE
 * EVIDENCE, and a verification note, as four explicit buttons over one note.
 *
 * What the note means depends on the button, and the label says so: what you
 * CHECKED (verified), WHY (reject, mismatch), what is MISSING (need more
 * evidence). The decision is a person's: each button is a submit of this one
 * form to `decideClaimAction`, which routes to the audited door
 * (`verify_payment_submission` / `request_payment_evidence`). Verified, rejected
 * and mismatch need the note; the server refuses an empty one with the reason.
 */
export function ClaimDecision({ claimId, invoiceId, projectId }: { claimId: string; invoiceId: string; projectId: string | null }) {
  const [state, action, pending] = useActionState(decideClaimAction, IDLE_STATE);
  const noteId = useId();

  return (
    <form action={action} className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      <input type="hidden" name="submissionId" value={claimId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor={noteId}>
          Verification note
        </label>
        <textarea
          id={noteId}
          name="note"
          rows={2}
          maxLength={2000}
          className={inputClass}
          placeholder="Verified: what you checked (statement line, UTR). Reject or mismatch: why. Need more evidence: what is missing."
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" name="intent" value="verify" disabled={pending} className={buttonClass('primary', 'sm')}>
          PAYMENT VERIFIED
        </button>
        <button type="submit" name="intent" value="evidence" disabled={pending} className={buttonClass('secondary', 'sm')}>
          Need more evidence
        </button>
        <button type="submit" name="intent" value="mismatch" disabled={pending} className={buttonClass('secondary', 'sm')}>
          Flag a mismatch
        </button>
        <button type="submit" name="intent" value="reject" disabled={pending} className={buttonClass('secondary', 'sm', 'text-danger')}>
          Reject
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
