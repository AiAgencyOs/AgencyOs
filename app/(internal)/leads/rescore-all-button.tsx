'use client';

import { useActionState } from 'react';

import { rescoreAllLeadsAction } from '@/modules/crm/lead-score-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass } from '@/ui';

/**
 * ADM-88 — Decision: reversed by the owner on 2026-09-29. The rescore-all
 * pass, run from the list: every undeleted lead (bounded, oldest score
 * first), each its own audited write. What was and was not scored is said.
 */
export function RescoreAllLeadsButton() {
  const [state, action, pending] = useActionState(rescoreAllLeadsAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Scoring…' : 'Rescore all'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
