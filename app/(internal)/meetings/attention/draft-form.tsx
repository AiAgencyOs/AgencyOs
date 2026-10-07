'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { discardDraftAction, sendDraftAction } from './draft-actions';

/** The drafted message, editable, with the two things a person can do: send it (the ordinary outbound path) or discard it with a reason. */
export function SchedulingDraftForm({ draftId, body, canSend }: { draftId: string; body: string; canSend: boolean }) {
  const [sendState, send, sending] = useActionState(sendDraftAction, IDLE_STATE);
  const [discardState, discard, discarding] = useActionState(discardDraftAction, IDLE_STATE);
  return (
    <div className="flex flex-col gap-2">
      <form action={send} className="flex flex-col gap-2">
        <input type="hidden" name="draftId" value={draftId} />
        <textarea name="body" required maxLength={1500} rows={5} defaultValue={body} aria-label="The message to the client" className={`${inputClass} w-full text-sm`} />
        <div className="flex items-center gap-2">
          <button type="submit" disabled={sending || !canSend} className={buttonClass('primary', 'sm')}>{sending ? 'Sending…' : 'Send to the client'}</button>
          <FormMessage status={sendState.status} message={sendState.message} className="text-xs" />
        </div>
      </form>
      {canSend ? (
        <form action={discard} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="draftId" value={draftId} />
          <input name="reason" required maxLength={500} placeholder="why not send it" aria-label="Why this draft is discarded" className={`${inputClass} h-7 w-56 text-xs`} />
          <button type="submit" disabled={discarding} className={buttonClass('secondary', 'sm')}>{discarding ? 'Saving…' : 'Discard'}</button>
          <FormMessage status={discardState.status} message={discardState.message} className="text-xs" />
        </form>
      ) : null}
    </div>
  );
}
