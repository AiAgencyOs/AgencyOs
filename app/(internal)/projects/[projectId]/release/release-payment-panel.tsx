'use client';

import { useActionState } from 'react';

import { overrideReleasePaymentAction } from '@/modules/projects/release-payment-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, labelClass, textareaClass } from '@/ui';

/**
 * Decision F1 (2026-09-30) — the owner's override of the payment gate. The
 * page draws it only for the owner and only while the gate refuses; the
 * door (`projects.override_release_payment`) decides both again and audits
 * `release.payment_overridden` with these words.
 */
export function OverrideReleasePaymentForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(overrideReleasePaymentAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="override-reason" className={labelClass}>Why the release goes out before the final payment is verified</label>
        <textarea id="override-reason" name="reason" required minLength={10} maxLength={2000} rows={2} className={textareaClass} placeholder="Client's finance team confirmed the transfer on the 3rd; bank shows it on the 5th. Go-ahead in writing on the thread." />
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('danger', 'sm')} self-start`}>
        {pending ? 'Recording…' : 'Override the payment gate'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
