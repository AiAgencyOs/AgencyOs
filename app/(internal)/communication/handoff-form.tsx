'use client';

import { useActionState } from 'react';

import { setLeadOwnerAction } from '@/modules/crm/assign-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, selectClass } from '@/ui';

/**
 * Hand a waiting conversation to a person — SCR-057. The select offers the
 * internal roster because that is what the door accepts; the door re-checks
 * the capability and the membership, and RLS decides again at the row.
 * Refusals are shown as written.
 */
export function HandoffForm({
  leadId,
  current,
  roster,
}: {
  leadId: string;
  current: string | null;
  roster: { userId: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState(setLeadOwnerAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <select name="assigneeId" defaultValue={current ?? ''} aria-label="Assign to" className={`${selectClass} w-auto`}>
        <option value="">Nobody assigned</option>
        {roster.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.fullName}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Assigning…' : 'Assign'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
