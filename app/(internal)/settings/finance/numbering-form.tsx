'use client';

import { useActionState, useId } from 'react';

import { setOrganizationSettingAction } from '../actions';
import { setInvoiceNumberingAction } from '@/modules/finance/numbering-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * Settings › Finance › invoice numbering and terms (PDF §7). A prefix (default
 * INV), the default payment terms in days and a note printed on the invoice.
 * All three are optional: empty means "as before".
 */
export function InvoiceNumberingForm({ prefix, termsDays, termsNote, example }: { prefix: string | null; termsDays: string | null; termsNote: string | null; example: string }) {
  const [state, action, pending] = useActionState(setInvoiceNumberingAction, IDLE_STATE);
  const uid = useId();
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor={`${uid}-prefix`}>Number prefix</label>
          <input id={`${uid}-prefix`} name="prefix" defaultValue={prefix ?? ''} placeholder="INV" maxLength={8} className={`${inputClass} w-28 font-mono uppercase`} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor={`${uid}-days`}>Default terms (days)</label>
          <input id={`${uid}-days`} name="termsDays" inputMode="numeric" defaultValue={termsDays ?? ''} placeholder="none" className={`${inputClass} w-28 tabular`} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor={`${uid}-note`}>Terms note printed on the invoice (optional)</label>
        <textarea id={`${uid}-note`} name="termsNote" rows={2} maxLength={500} defaultValue={termsNote ?? ''} className={inputClass} />
      </div>
      <p className="text-xs text-muted">Next number: <span className="font-mono">{example}</span>. Clear a field to go back to the old behaviour.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save numbering and terms'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/**
 * The payment half of the WON gate (G-230): a switch. 'on' requires a captured
 * payment or an approved exception before a deal may be won; off requires only
 * the accepted quotation the gate always enforces. The door is the existing
 * whitelisted `core.set_organization_setting` — audited with old and new.
 */
export function WonGateForm({ on }: { on: boolean }) {
  const [state, action, pending] = useActionState(setOrganizationSettingAction, IDLE_STATE);
  const uid = useId();
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="key" value="won_requires_payment_evidence" />
      <label className="flex items-center gap-2 text-sm" htmlFor={`${uid}-on`}>
        <input id={`${uid}-on`} type="checkbox" name="on" defaultChecked={on} className="h-4 w-4" />
        Require payment evidence before a deal may be marked won
      </label>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
