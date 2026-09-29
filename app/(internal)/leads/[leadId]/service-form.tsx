'use client';

import { useActionState } from 'react';

import { setLeadServiceAction } from '@/modules/crm/lead-service-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, FormMessage, inputClass } from '@/ui';

/**
 * SCR-006 — the service field on the Lead 360 information card. Free text,
 * at most 80 characters; the door (`setLeadService`) re-checks `lead.write`
 * and RLS decides again. Blank clears it.
 */
export function LeadServiceForm({
  leadId,
  service,
  suggestions,
}: {
  leadId: string;
  service: string | null;
  suggestions: string[];
}) {
  const [state, action, pending] = useActionState(setLeadServiceAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="leadId" value={leadId} />
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          name="service"
          defaultValue={service ?? ''}
          maxLength={80}
          list="lead-service-suggestions"
          placeholder="e.g. Website redesign"
          aria-label="Service the lead asked about"
          className={cx(inputClass, 'h-8 w-44 text-[13px]')}
        />
        <datalist id="lead-service-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
