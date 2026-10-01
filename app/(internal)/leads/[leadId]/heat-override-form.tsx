'use client';

import { useActionState, useId } from 'react';

import { overrideLeadHeatAction } from '@/modules/crm/lead-heat-override-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/**
 * Q-OVERRIDE — set the Hot / Warm / Cold label by hand, with a reason, beside
 * the computed one; or clear it. Both go through `crm.override_lead_heat` and
 * are audited.
 */
export function HeatOverrideForm({ leadId, current }: { leadId: string; current: 'Hot' | 'Warm' | 'Cold' | null }) {
  const [state, action, pending] = useActionState(overrideLeadHeatAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <label htmlFor={`${id}-label`} className={labelClass}>Label</label>
      <select id={`${id}-label`} name="label" defaultValue={current ?? 'Warm'} className={selectClass}>
        <option value="Hot">Hot</option>
        <option value="Warm">Warm</option>
        <option value="Cold">Cold</option>
      </select>
      <label htmlFor={`${id}-why`} className={labelClass}>Reason</label>
      <input id={`${id}-why`} name="reason" required maxLength={500} placeholder="e.g. the founder confirmed budget on a call" className={inputClass} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Set label'}
        </button>
        {current ? (
          <button type="submit" name="clear" value="1" disabled={pending} className={buttonClass('ghost', 'sm')}>
            Clear override
          </button>
        ) : null}
      </div>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
