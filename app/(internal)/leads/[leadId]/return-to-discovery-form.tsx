'use client';

import { useActionState, useId } from 'react';

import { setLeadStatusAction } from '@/modules/crm/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass } from '@/ui';

/**
 * SCR-008 "Return to discovery when evidence is incomplete": the guarded
 * `qualified → qualifying` (or `nurture → qualifying`) move through the lead
 * status door, with the reason kept on the lead's timeline. Offered only where
 * `LEAD_TRANSITIONS` allows the move.
 */
export function ReturnToDiscoveryForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(setLeadStatusAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="status" value="qualifying" />
      <label htmlFor={`${id}-why`} className={labelClass}>What evidence is still missing?</label>
      <input id={`${id}-why`} name="reason" required maxLength={500} placeholder="e.g. budget and decision maker still unknown" className={inputClass} />
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Returning…' : 'Return to discovery'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
