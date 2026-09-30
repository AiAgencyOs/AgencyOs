'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, FormMessage, inputClass, selectClass } from '@/ui';

import { bulkClientAction } from './bulk-actions';

/** The form id every row checkbox points at (`form=` attribute), so selection needs no client state. */
export const CLIENT_BULK_FORM = 'client-bulk-form';

/**
 * SCR-014's bulk bar over the ticked rows: assign a relationship owner or add
 * a tag. The rows' checkboxes are plain server-rendered inputs tied to this
 * form by id; the action reads them with `getAll('id')`.
 */
export function ClientBulkBar({ roster }: { roster: { userId: string; fullName: string }[] }) {
  const [state, action, pending] = useActionState(bulkClientAction, IDLE_STATE);
  const [kind, setKind] = useState<'owner' | 'tag'>('owner');
  const uid = useId();
  return (
    <form id={CLIENT_BULK_FORM} action={action} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
      <span className="text-xs text-muted">With the ticked clients:</span>
      <label htmlFor={`${uid}-kind`} className="sr-only">Bulk action</label>
      <select id={`${uid}-kind`} name="kind" value={kind} onChange={(e) => setKind(e.target.value as 'owner' | 'tag')} className={cx(selectClass, 'h-8 w-auto text-[13px]')}>
        <option value="owner">Assign relationship owner</option>
        <option value="tag">Add tag</option>
      </select>
      {kind === 'owner' ? (
        <>
          <label htmlFor={`${uid}-owner`} className="sr-only">Relationship owner</label>
          <select id={`${uid}-owner`} name="ownerId" defaultValue="" className={cx(selectClass, 'h-8 w-48 text-[13px]')}>
            <option value="">No owner (clear)</option>
            {roster.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.fullName}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label htmlFor={`${uid}-tag`} className="sr-only">Tag to add</label>
          <input id={`${uid}-tag`} name="tag" required maxLength={40} placeholder="Tag to add" className={cx(inputClass, 'h-8 w-40 text-[13px]')} />
        </>
      )}
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Applying…' : 'Apply'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
