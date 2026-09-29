'use client';

import { useActionState, useEffect, useRef } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, textareaClass } from '@/ui';

import { addClientNoteAction } from './actions';

/**
 * SCR-017's Notes half. Append-only, like `crm.lead_activities` notes — this
 * form only ever adds; there is no edit or delete, matching that precedent
 * and the migration's own RLS (insert-only policy, no update/delete grant).
 */
export function AddClientNoteForm({ clientAccountId }: { clientAccountId: string }) {
  const [state, action, pending] = useActionState(addClientNoteAction, IDLE_STATE);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'success') formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="clientAccountId" value={clientAccountId} />
      <textarea
        name="body"
        required
        maxLength={5000}
        rows={3}
        placeholder="Add a note for the team — never shown to the client."
        className={textareaClass}
      />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Add note'}
        </button>
        {state.status !== 'idle' && state.message ? (
          <span className={`text-xs ${state.status === 'error' ? 'text-danger' : 'text-success'}`}>
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
