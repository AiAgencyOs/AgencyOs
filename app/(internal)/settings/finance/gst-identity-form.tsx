'use client';

import { useActionState } from 'react';

import { setGstIdentityAction } from '@/modules/finance/gst-identity-actions';
import { SUGGESTED_SAC } from '@/modules/finance/gst-identity-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * Settings › Finance › GST identity — bucket E5. The agency's own GSTIN, the
 * state it is registered in and the SAC its lines are classified under.
 * Owner only; the door audits old and new. Leaving the state blank lets the
 * database take it from the GSTIN's first two characters.
 */
export function GstIdentityForm({ gstin, stateCode, defaultSac }: { gstin: string | null; stateCode: string | null; defaultSac: string | null }) {
  const [state, action, pending] = useActionState(setGstIdentityAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Agency GSTIN</span>
          <input type="text" name="gstin" defaultValue={gstin ?? ''} placeholder="27AAPFU0939F1ZV" maxLength={15} className={`${inputClass} w-48 font-mono uppercase`} autoComplete="off" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>State code</span>
          <input type="text" inputMode="numeric" name="stateCode" defaultValue={stateCode ?? ''} placeholder="from GSTIN" maxLength={2} className={`${inputClass} w-24 font-mono tabular`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Default SAC</span>
          <input type="text" inputMode="numeric" name="defaultSac" defaultValue={defaultSac ?? ''} placeholder={`e.g. ${SUGGESTED_SAC}`} maxLength={8} className={`${inputClass} w-32 font-mono tabular`} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
