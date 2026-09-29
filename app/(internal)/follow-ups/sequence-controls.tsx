'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { resumeFollowUpSequenceAction, stopFollowUpSequenceAction } from '@/modules/crm/actions';
import { buttonClass, FormMessage, inputClass } from '@/ui';

/**
 * Stop or resume one sequence from the list. The write is the module's own
 * door; the row's status is re-read after the action, never assumed.
 */
export function SequenceControls({ sequenceId, status }: { sequenceId: string; status: string }) {
  const [open, setOpen] = useState(false);
  const [stopState, stopAction, stopping] = useActionState(stopFollowUpSequenceAction, IDLE_STATE);
  const [resumeState, resumeAction, resuming] = useActionState(resumeFollowUpSequenceAction, IDLE_STATE);

  if (status === 'stopped') {
    return (
      <form action={resumeAction} className="flex items-center gap-2">
        <input type="hidden" name="sequenceId" value={sequenceId} />
        <button type="submit" disabled={resuming} className={buttonClass('secondary', 'sm')}>
          {resuming ? 'Resuming…' : 'Resume'}
        </button>
        <FormMessage status={resumeState.status} message={resumeState.message} />
      </form>
    );
  }
  if (status !== 'active') return <span className="text-xs text-muted">—</span>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')}>
        Stop
      </button>
    );
  }
  return (
    <form action={stopAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="sequenceId" value={sequenceId} />
      <input name="reason" required maxLength={200} placeholder="Why" aria-label="Why stop this sequence" className={`${inputClass} w-44`} />
      <button type="submit" disabled={stopping} className={buttonClass('danger', 'sm')}>
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
        Cancel
      </button>
      <FormMessage status={stopState.status} message={stopState.message} />
    </form>
  );
}
