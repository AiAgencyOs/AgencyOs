'use client';

import { useActionState, useEffect } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage } from '@/ui';

import { ACTION_ITEMS_CHANGED_EVENT } from './changed-event';
import { setNotificationStateAction } from './state-actions';

/**
 * SCR-001 "Acknowledge an operational item": marks the item read for this
 * person through the inbox's own door (`core.set_notification_state`), so it
 * stops counting against them and the bell drops. Escalation, for the items
 * that need somebody else, sits beside it.
 */
export function AcknowledgeButton({ itemKey }: { itemKey: string }) {
  const [state, action, pending] = useActionState(setNotificationStateAction, IDLE_STATE);
  useEffect(() => {
    if (state.status === 'success') window.dispatchEvent(new Event(ACTION_ITEMS_CHANGED_EVENT));
  }, [state]);
  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="key" value={itemKey} />
      <input type="hidden" name="state" value="read" />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Acknowledging…' : 'Acknowledge'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
