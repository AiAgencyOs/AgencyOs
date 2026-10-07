'use client';

import { useActionState, useId } from 'react';

import { activatePolicyVersionAction, discardPolicyDraftAction, savePolicyDraftAction } from '@/modules/approvals/p13-policy-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, textareaClass } from '@/ui';

/** Save (or edit) the one draft of a kind. A draft changes nothing until an admin activates it. */
export function DraftForm({ kind, summary, bodyText }: { kind: string; summary: string; bodyText: string }) {
  const [state, action, pending] = useActionState(savePolicyDraftAction, IDLE_STATE);
  const sid = useId();
  const bid = useId();
  const eid = useId();
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="kind" value={kind} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={sid} className={labelClass}>
          What this version changes
        </label>
        <input id={sid} name="summary" required maxLength={300} defaultValue={summary} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={bid} className={labelClass}>
          Policy (JSON object)
        </label>
        <textarea id={bid} name="body" rows={8} maxLength={20000} defaultValue={bodyText} className={textareaClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={eid} className={labelClass}>
          Takes effect from (optional, not in the past)
        </label>
        <input id={eid} name="effectiveFrom" type="datetime-local" className={inputClass} />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function ActivateForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(activatePolicyVersionAction, IDLE_STATE);
  const rid = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={rid} className={labelClass}>
        Reason for activating
      </label>
      <input id={rid} name="reason" required maxLength={500} className={inputClass} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Activating…' : 'Activate this version'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function DiscardForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(discardPolicyDraftAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Discarding…' : 'Discard draft'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
