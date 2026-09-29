'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage } from '@/ui';

import { setClientTeamAction } from '../edit-actions';

/**
 * SCR-015 — the assigned team as a multi-select of members. Checkboxes
 * rather than a `<select multiple>`: a person picking three names from
 * twenty should not need to know about ctrl-click. The set is replaced
 * whole through `core.set_client_account_team`, audited.
 */
export function ClientTeamForm({
  clientAccountId,
  members,
  assigned,
}: {
  clientAccountId: string;
  members: readonly { userId: string; fullName: string; role: string }[];
  assigned: readonly string[];
}) {
  const [state, action, pending] = useActionState(setClientTeamAction, IDLE_STATE);
  const chosen = new Set(assigned);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="clientAccountId" value={clientAccountId} />
      {members.length === 0 ? (
        <p className="text-[13px] text-muted">No active member to assign.</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2">
          {members.map((m) => (
            <li key={m.userId}>
              <label className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-surface-hover">
                <input type="checkbox" name="userIds" value={m.userId} defaultChecked={chosen.has(m.userId)} className="h-4 w-4 rounded border-line-strong" />
                <span className="min-w-0 flex-1 truncate">{m.fullName}</span>
                <span className="text-xs text-muted">{m.role.replace(/_/g, ' ')}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || members.length === 0} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save team'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}
