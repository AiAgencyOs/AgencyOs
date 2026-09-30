'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, FormMessage, inputClass, selectClass } from '@/ui';

import { setClientOwnerAction, setClientTagsAction } from './ownership-actions';

/**
 * SCR-014 — the tags editor and the owner select on Client 360 › details.
 * Both post to their own door (`lib/admin/client-ownership.ts`), which
 * re-checks `project.write` and lets RLS decide again; refusals are shown
 * as the door said them.
 */
export function ClientTagsForm({ clientAccountId, tags }: { clientAccountId: string; tags: string[] }) {
  const [state, action, pending] = useActionState(setClientTagsAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="clientAccountId" value={clientAccountId} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="tags"
          defaultValue={tags.join(', ')}
          placeholder="e.g. retail, tier-1, referral"
          aria-label="Client tags, comma separated"
          className={cx(inputClass, 'h-9 w-64 text-[13px]')}
        />
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save tags'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function ClientOwnerForm({
  clientAccountId,
  ownerId,
  roster,
}: {
  clientAccountId: string;
  ownerId: string | null;
  roster: { userId: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState(setClientOwnerAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="clientAccountId" value={clientAccountId} />
      <div className="flex flex-wrap items-center gap-2">
        <select name="ownerId" defaultValue={ownerId ?? ''} aria-label="Relationship owner" className={cx(selectClass, 'h-9 w-64 text-[13px]')}>
          <option value="">No owner</option>
          {roster.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.fullName}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Set owner'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
