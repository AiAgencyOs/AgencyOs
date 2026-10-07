'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, textareaClass } from '@/ui';

import { requestHandoverAcceptanceAction } from './actions';

/**
 * Two requests about the delivered version. Neither is an acceptance: they are sent to your project contact, who confirms with you before the acceptance is
 * recorded against this exact version.
 */
export function HandoverRequestForm({ projectId, packageId, version }: { projectId: string; packageId: string; version: number }) {
  const [acceptState, acceptAction, acceptPending] = useActionState(requestHandoverAcceptanceAction, IDLE_STATE);
  const [changeState, changeAction, changePending] = useActionState(requestHandoverAcceptanceAction, IDLE_STATE);
  return (
    <div className="flex flex-col gap-4">
      <form action={acceptAction} className="flex flex-col gap-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="packageId" value={packageId} />
        <input type="hidden" name="kind" value="acceptance_request" />
        <label className="flex flex-col gap-1 text-sm">
          <span>A note for your project contact (optional)</span>
          <textarea name="note" rows={2} className={textareaClass} />
        </label>
        <button type="submit" disabled={acceptPending} className={buttonClass('primary')}>
          {acceptPending ? 'Sending...' : `I would like to accept version ${version}`}
        </button>
        <FormMessage status={acceptState.status} message={acceptState.message} />
      </form>
      <form action={changeAction} className="flex flex-col gap-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="packageId" value={packageId} />
        <input type="hidden" name="kind" value="changes_request" />
        <label className="flex flex-col gap-1 text-sm">
          <span>Something is missing or wrong in this version</span>
          <textarea name="note" rows={3} required className={textareaClass} />
        </label>
        <button type="submit" disabled={changePending} className={buttonClass('secondary')}>
          {changePending ? 'Sending...' : 'Ask for changes'}
        </button>
        <FormMessage status={changeState.status} message={changeState.message} />
      </form>
    </div>
  );
}
