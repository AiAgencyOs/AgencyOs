'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, textareaClass } from '@/ui';

import { recordManualOverrideAction } from './override-actions';

/**
 * Record an exception — SCR-068's "record exception / override with reason"
 * for the cases no domain door covers. Owner only; the door refuses everyone
 * else and the refusal is shown as written. A subject id is optional (a
 * UUID when there is a record to point at), an expiry says when the
 * exception stops applying.
 */
export function ManualOverrideForm() {
  const [state, action, pending] = useActionState(recordManualOverrideAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>About what</span>
          <input name="subjectType" required maxLength={40} placeholder="invoice, project, lead…" className={`${inputClass} w-40`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Record id (optional)</span>
          <input name="subjectId" placeholder="UUID" className={`${inputClass} w-72 font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Kind</span>
          <input name="kind" required maxLength={60} placeholder="late_invoice" className={`${inputClass} w-44 font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Expires (optional)</span>
          <input type="datetime-local" name="expiresAt" className={inputClass} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Reason</span>
        <textarea name="reason" required minLength={10} maxLength={2000} rows={2} placeholder="Why the rule is being set aside, in at least ten characters" className={textareaClass} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Recording…' : 'Record exception'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}
