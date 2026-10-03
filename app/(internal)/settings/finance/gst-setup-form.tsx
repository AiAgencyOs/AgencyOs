'use client';

import { useActionState, useId } from 'react';

import { setGstSetupAction } from '@/modules/finance/gst-setup-actions';
import {
  GST_FILING_FREQUENCIES,
  GST_FILING_LABEL,
  GST_PERIOD_BASES,
  GST_PERIOD_LABEL,
  GST_REGISTRATION_LABEL,
  GST_REGISTRATION_TYPES,
  type GstSetup,
} from '@/modules/finance/gst-settings';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, labelClass, selectClass } from '@/ui';

/**
 * Settings › Finance › GST setup (owner decision 9, 2026-10-01). Three closed
 * choices, shown with what applies today (the saved value, else the decision's
 * default). The door is the shared settings door: owner / ops_admin, audited.
 */
export function GstSetupForm({ setup }: { setup: GstSetup }) {
  const [state, action, pending] = useActionState(setGstSetupAction, IDLE_STATE);
  const uid = useId();
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor={`${uid}-reg`}>Registration type</label>
          <select id={`${uid}-reg`} name="registrationType" defaultValue={setup.registrationType} className={`${selectClass} sm:w-52`}>
            {GST_REGISTRATION_TYPES.map((v) => (
              <option key={v} value={v}>{GST_REGISTRATION_LABEL[v]}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor={`${uid}-freq`}>Filing frequency</label>
          <select id={`${uid}-freq`} name="filingFrequency" defaultValue={setup.filingFrequency} className={`${selectClass} sm:w-72`}>
            {GST_FILING_FREQUENCIES.map((v) => (
              <option key={v} value={v}>{GST_FILING_LABEL[v]}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor={`${uid}-basis`}>Tax period</label>
          <select id={`${uid}-basis`} name="periodBasis" defaultValue={setup.periodBasis} className={`${selectClass} sm:w-44`}>
            {GST_PERIOD_BASES.map((v) => (
              <option key={v} value={v}>{GST_PERIOD_LABEL[v]}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save GST setup'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
