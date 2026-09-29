'use client';

import { useActionState } from 'react';

import { rescoreLeadAction } from '@/modules/crm/lead-score-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass } from '@/ui';

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
