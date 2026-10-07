'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { resolveTaxFlagAction, saveLimitsAction, saveTaxConfigAction } from './actions';

export function TaxConfigForm({ mode, ratePercent, canEdit }: { mode: 'gst' | 'non_gst' | null; ratePercent: string; canEdit: boolean }) {
  const [state, action, pending] = useActionState(saveTaxConfigAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <fieldset disabled={!canEdit || pending} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">Tax on quotations
          <select name="mode" defaultValue={mode ?? 'gst'} className={`${inputClass} h-9`}><option value="gst">GST is charged</option><option value="non_gst">No GST</option></select>
        </label>
        <label className="flex flex-col gap-1 text-sm">GST rate (%)<input name="ratePercent" inputMode="decimal" defaultValue={ratePercent} placeholder="18" className={`${inputClass} h-9 w-24`} /></label>
        <label className="flex flex-col gap-1 text-sm">Note (optional)<input name="note" maxLength={500} className={`${inputClass} h-9 w-64`} /></label>
        {canEdit ? <button type="submit" className={buttonClass('primary', 'md')}>{pending ? 'Saving…' : 'Save'}</button> : null}
      </fieldset>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function LimitsForm({ maxDiscountRupees, minAdvance, canEdit }: { maxDiscountRupees: string; minAdvance: string; canEdit: boolean }) {
  const [state, action, pending] = useActionState(saveLimitsAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <fieldset disabled={!canEdit || pending} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">Largest discount (rupees)<input name="maxDiscount" inputMode="decimal" defaultValue={maxDiscountRupees} placeholder="no limit" className={`${inputClass} h-9 w-36`} /></label>
        <label className="flex flex-col gap-1 text-sm">Smallest advance (%)<input name="minAdvance" inputMode="decimal" defaultValue={minAdvance} placeholder="no limit" className={`${inputClass} h-9 w-32`} /></label>
        {canEdit ? <button type="submit" className={buttonClass('primary', 'md')}>{pending ? 'Saving…' : 'Save'}</button> : null}
      </fieldset>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ResolveTaxFlagForm({ flagId }: { flagId: string }) {
  const [state, action, pending] = useActionState(resolveTaxFlagAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="flagId" value={flagId} />
      <input name="note" required maxLength={1000} placeholder="how the tax treatment was settled" aria-label="How the tax treatment was settled" className={`${inputClass} h-7 w-72 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Resolve'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
