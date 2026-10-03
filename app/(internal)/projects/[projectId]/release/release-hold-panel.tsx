'use client';

import { useActionState } from 'react';

import { holdReleaseAction, liftReleaseHoldAction } from '@/modules/projects/release-hold-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { Callout, FormMessage, buttonClass, labelClass, textareaClass } from '@/ui';

/**
 * SCR-044 — hold a release, or lift the hold. `project.sign_off` only (the
 * page hides the forms from everyone else; the doors refuse them anyway).
 */
export function HoldReleaseForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(holdReleaseAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="hold-reason" className={labelClass}>Why the release is held</label>
        <textarea id="hold-reason" name="reason" required minLength={10} maxLength={2000} rows={2} className={textareaClass} placeholder="Client asked for a freeze until their audit closes on the 14th." />
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('danger', 'sm')} self-start`}>
        {pending ? 'Holding…' : 'Hold the release'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function LiftReleaseHoldForm({ projectId, reason, heldLabel }: { projectId: string; reason: string; heldLabel: string }) {
  const [state, action, pending] = useActionState(liftReleaseHoldAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <Callout tone="danger" title="Release held">
        <span className="whitespace-pre-wrap">{reason}</span>
        <span className="mt-1 block text-xs">{heldLabel}</span>
      </Callout>
      <div className="flex flex-col gap-1">
        <label htmlFor="lift-reason" className={labelClass}>Why it is lifted</label>
        <textarea id="lift-reason" name="reason" required minLength={10} maxLength={2000} rows={2} className={textareaClass} placeholder="Client confirmed the audit closed; go-ahead in writing on the thread." />
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Lifting…' : 'Lift the hold'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
