'use client';

import { useActionState, useState } from 'react';

import { rescoreLeadAction } from '@/modules/crm/lead-score-actions';
import { overrideLeadScoreAction } from '@/modules/crm/lead-score-override-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * ADM-88 — Decision: reversed by the owner on 2026-09-29. The Lead 360's
 * "Rescore" button: nothing is typed, the number is recomputed from the
 * lead's recorded facts by `lead-score.ts` and stored with its reasons.
 */
export function RescoreLeadForm({ leadId, scored }: { leadId: string; scored: boolean }) {
  const [state, action, pending] = useActionState(rescoreLeadAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Scoring…' : scored ? 'Rescore' : 'Score this lead'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

/**
 * SCR-008 — the human decision beside the model's number. Owner/ops_admin
 * only (the door checks `lead.assign` and the database checks
 * `core.is_admin()` again). A reason is required to set AND to clear, and
 * the computed score is never touched: the page draws both.
 */
export function OverrideScoreForm({ leadId, current }: { leadId: string; current: { score: number; reason: string } | null }) {
  const [state, action, pending] = useActionState(overrideLeadScoreAction, IDLE_STATE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')}>
        {current ? 'Change override' : 'Override with reason'}
      </button>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
      <input type="hidden" name="leadId" value={leadId} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="override-score">Your score (0–100)</label>
          <input id="override-score" name="score" type="number" min={0} max={100} step={1} defaultValue={current?.score ?? ''} className={`${inputClass} w-28`} />
        </div>
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <label className={labelClass} htmlFor="override-reason">Why (required)</label>
          <input id="override-reason" name="reason" required maxLength={500} defaultValue={current?.reason ?? ''} placeholder="What the model cannot see" className={inputClass} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Recording…' : 'Record override'}
        </button>
        {current ? (
          <button type="submit" name="clear" value="1" disabled={pending} className={buttonClass('ghost', 'sm')}>
            Clear override (with the reason above)
          </button>
        ) : null}
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
