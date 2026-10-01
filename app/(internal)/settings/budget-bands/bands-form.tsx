'use client';

import { useActionState, useId } from 'react';

import { setBudgetBandsAction } from '@/modules/crm/budget-bands-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, labelClass, textareaClass } from '@/ui';

/** Settings › Budget Bands — the owner's bands, one per line, saved through one audited door. */
export function BudgetBandsForm({ bandText, mayEdit }: { bandText: string; mayEdit: boolean }) {
  const [state, action, pending] = useActionState(setBudgetBandsAction, IDLE_STATE);
  const textId = useId();
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={textId} className={labelClass}>
          Bands
        </label>
        <textarea id={textId} name="bandText" rows={7} maxLength={2000} defaultValue={bandText} disabled={!mayEdit} className={textareaClass} placeholder={'0 Under ₹50K\n50000 Small\n200000 Medium'} />
        <p className="text-[11px] text-muted">
          One band per line: the rupee figure it starts at, a space, then its name. The first must start at 0; each band runs up to where the next begins, and the last has no upper end. Leave blank to use the starting bands.
        </p>
      </div>
      {mayEdit ? (
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Saving…' : 'Save bands'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      ) : null}
    </form>
  );
}
