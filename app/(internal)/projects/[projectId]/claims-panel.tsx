'use client';

import { useActionState } from 'react';

import {
  recordPaymentSubmissionAction,
  verifyPaymentSubmissionAction,
} from '@/modules/finance/actions';
import type { PaymentClaim } from '@/modules/finance/queries';
import { SUBMISSION_METHODS } from '@/modules/finance/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * What somebody said they paid — Doc 15 §11 and §12; G-272.
 *
 * The table, the guard, the door and §4.7's three decisions were all built and
 * **nothing in the application touched any of it**, on either side. The verify
 * half was deliberately not built alone: a queue nothing can put a claim into
 * is an always-empty list, which is the same defect wearing a page.
 *
 * ── the distinction this panel exists to keep ─────────────────────────
 *
 * **A claim is not money.** `finance.payments` is the ledger and the manual
 * payment form writes it; a claim moves no invoice, unlocks no milestone and
 * appears in no total. Confirming one records that somebody CHECKED it — the
 * ledger row is still a separate act, and the wording says so rather than
 * letting a confirmation read as a receipt.
 *
 * **Verification is a person's.** The table has no `verified_by_agent` column,
 * the door takes the caller's own id, and the guard refuses any other name:
 * *"you may only say that YOU checked it"*.
 *
 * **A mismatch is not a rejection.** §6 calls it *requires resolution*, so the
 * claim stays answerable — the guard lets it move again — and it is the one
 * decision that does not stamp a verifier, because doing so would make the
 * queue of unchecked claims look shorter than it is.
 */

const input = inputClass;
const label = labelClass;

function Status({ state }: { state: { status: string; message?: string } }) {
  return <FormMessage status={state.status} message={state.message} />;
}

export function RecordClaimForm({
  projectId,
  invoices,
}: {
  projectId: string;
  invoices: { id: string; number: string; status: string }[];
}) {
  const [state, action, pending] = useActionState(recordPaymentSubmissionAction, IDLE_STATE);

  if (invoices.length === 0) return null;

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <label className={label} htmlFor="claim-invoice">
            Against
          </label>
          <select id="claim-invoice" name="invoiceId" required defaultValue="" className={selectClass}>
            <option value="" disabled>
              Which invoice?
            </option>
            {invoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} · {i.status}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor="claim-amount">
            Amount claimed
          </label>
          <input id="claim-amount" name="amount" required inputMode="decimal" className={`${input} w-32`} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor="claim-method">
            How
          </label>
          <select id="claim-method" name="method" required defaultValue="bank_transfer" className={selectClass}>
            {SUBMISSION_METHODS.map((m) => (
              <option key={m} value={m}>
                {m.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {/*
          §36 asks for exact references. Required for every method that has
          one — the schema refuses a bank transfer without it — and cash is the
          exception the column's nullability exists for.
        */}
        <input name="reference" maxLength={120} placeholder="Reference — UTR, cheque no." aria-label="Reference" className={`${input} min-w-40 flex-1`} />
        <input name="payerName" maxLength={200} placeholder="Who says they paid" aria-label="Payer" className={`${input} min-w-40 flex-1`} />
        <input name="paidAt" type="datetime-local" aria-label="When they say they paid" className={input} />
      </div>
      <input name="proofUrl" type="url" placeholder="Link to a screenshot or receipt" aria-label="Proof" className={input} />

      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Recording…' : 'Record what they said they paid'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function VerifyClaimForm({
  projectId,
  claim,
}: {
  projectId: string;
  claim: PaymentClaim;
}) {
  const [state, action, pending] = useActionState(verifyPaymentSubmissionAction, IDLE_STATE);

  // `verified` and `rejected` are final; the guard refuses a further move.
  // `mismatch` is not — §6 calls it *requires resolution*, and a resolution the
  // row refuses to record is not one.
  if (claim.status !== 'pending_verification' && claim.status !== 'mismatch') return null;

  return (
    <form action={action} className="mt-2 flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="invoiceId" value={claim.invoice_id} />
      <input type="hidden" name="submissionId" value={claim.id} />

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor={`claim-decision-${claim.id}`}>
            Decision
          </label>
          <select id={`claim-decision-${claim.id}`} name="decision" required defaultValue="confirm" className={selectClass}>
            <option value="confirm">confirm — I checked it</option>
            <option value="mismatch">mismatch — it does not match</option>
            <option value="reject">reject — it did not arrive</option>
          </select>
        </div>
        {/*
          Both fields are offered because the decision is chosen in the same
          form, and the door asks for one or the other: evidence for a
          confirmation, a reason for the other two. The schema refuses the
          wrong combination before the round trip.
        */}
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <label className={label} htmlFor={`claim-evidence-${claim.id}`}>
            What you checked (confirm)
          </label>
          <input id={`claim-evidence-${claim.id}`} name="evidence" maxLength={2000} className={input} />
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <label className={label} htmlFor={`claim-reason-${claim.id}`}>
            Why (mismatch or reject)
          </label>
          <input id={`claim-reason-${claim.id}`} name="reason" maxLength={2000} className={input} />
        </div>

        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Recording…' : 'Answer the claim'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}
