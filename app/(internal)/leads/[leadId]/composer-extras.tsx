'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setOpportunityOwnerAction } from '@/modules/sales/owner-actions';
import { FormMessage, buttonClass, labelClass, selectClass } from '@/ui';

/**
 * The composer's sales-owner select — SCR-012. `opportunities.owner_id`
 * was written once at creation and never shown; this is the door and the
 * field, over the roster the door accepts.
 */
export function SalesOwnerForm({
  leadId,
  opportunityId,
  ownerId,
  roster,
}: {
  leadId: string;
  opportunityId: string;
  ownerId: string | null;
  roster: { userId: string; fullName: string; role: string }[];
}) {
  const [state, action, pending] = useActionState(setOpportunityOwnerAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <label className={labelClass} htmlFor="deal-owner">
        Sales owner
      </label>
      <div className="flex flex-wrap gap-2">
        <select id="deal-owner" name="ownerId" defaultValue={ownerId ?? ''} required className={selectClass}>
          <option value="" disabled>
            Choose a person…
          </option>
          {roster.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.fullName} · {m.role.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Set owner'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
