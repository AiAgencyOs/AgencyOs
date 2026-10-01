'use client';

import { useActionState, useId } from 'react';

import { retryFailedDeliveryAction } from '@/modules/crm/delivery-retry-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, IconRefresh, inputClass } from '@/ui';

/**
 * SCR-057 — "Retry" on a failed client delivery. Drawn for everybody who can
 * see the row (Blueprint §11: a hidden control is not enforcement); whether
 * this caller may send is decided in `retryFailedDelivery` and again by the
 * database. A retry is a new send through the same door as the first, so the
 * 24-hour window and consent decide it again — and the refusal, when there
 * is one, is the reason the first send failed, said in the door's words.
 * SCR-060 "requeue with reason": a person says why they are sending it again,
 * and that reason is kept with the retry.
 */
export function RetryDeliveryForm({ messageId, leadId }: { messageId: string; leadId?: string }) {
  const [state, action, pending] = useActionState(retryFailedDeliveryAction, IDLE_STATE);
  const id = useId();

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="messageId" value={messageId} />
      {leadId ? <input type="hidden" name="leadId" value={leadId} /> : null}
      <label htmlFor={`${id}-reason`} className="sr-only">Why you are retrying this delivery</label>
      <input id={`${id}-reason`} name="reason" required minLength={5} maxLength={600} placeholder="Why retry? (e.g. the window reopened)" className={`${inputClass} h-8 min-w-44 flex-1 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        <IconRefresh size={13} />
        {pending ? 'Retrying…' : 'Retry'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
