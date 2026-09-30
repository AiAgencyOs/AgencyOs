'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setProjectStatusAction } from '@/modules/projects/actions';
import { buttonClass, FormMessage, labelClass, textareaClass } from '@/ui';

/**
 * SCR-018 — "Pause/resume with reason" on the list row. The same
 * `setProjectStatusAction` the project's own Move form uses: a pause must say
 * why (the service refuses without it); a resume may. Nothing new writes here.
 */
export function PauseResumeButton({ projectId, projectName, paused }: { projectId: string; projectName: string; paused: boolean }) {
  const [state, action, pending] = useActionState(setProjectStatusAction, IDLE_STATE);
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const verb = paused ? 'Resume' : 'Pause';

  if (!open || state.status === 'success') {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen(true)} aria-label={`${verb} ${projectName}`} className={buttonClass('ghost', 'sm')}>
          {verb}
        </button>
        {state.status !== 'idle' ? <FormMessage status={state.status} message={state.message} /> : null}
      </span>
    );
  }
  return (
    <form action={action} className="flex min-w-56 flex-col gap-1.5 text-left" >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="status" value={paused ? 'active' : 'on_hold'} />
      <label htmlFor={reasonId} className={labelClass}>
        {paused ? 'Why resume (optional)' : 'Why pause'}
      </label>
      <textarea id={reasonId} name="reason" required={!paused} maxLength={1000} rows={2} className={textareaClass} placeholder="Recorded on the audit trail" />
      <span className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : `${verb} project`}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </span>
    </form>
  );
}
