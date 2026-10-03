'use client';

import { useActionState } from 'react';

import { breakDownPlanAction } from '@/modules/projects/plan-breakdown-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass } from '@/ui';

/**
 * SCR-040 — one click from the plan's deliverables to the development
 * breakdown. The service walks the three existing doors per deliverable
 * and reports every refusal by name; pressing it twice skips deliverables
 * that already have a module.
 */
export function PlanBreakdownForm({ projectId, planId, deliverables }: { projectId: string; planId: string; deliverables: number }) {
  const [state, action, pending] = useActionState(breakDownPlanAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-dashed border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <p className="text-[13px] text-muted">
        Make a module, a feature and a task for each of the {deliverables} deliverable{deliverables === 1 ? '' : 's'} on the
        Development tab. A deliverable that already has a module of the same name is skipped.
      </p>
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Creating…' : 'Create modules, features and tasks from this plan'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
