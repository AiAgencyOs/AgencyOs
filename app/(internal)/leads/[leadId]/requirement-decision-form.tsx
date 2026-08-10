'use client';

import { useActionState } from 'react';

import { decideRequirementVersionAction } from '@/modules/crm/actions';
import { IDLE_STATE } from '@/modules/identity/types';

/**
 * Approve or reject one proposed requirement set.
 *
 * Rendered only for versions still `proposed`: an accepted or rejected set is
 * settled, and a failed one never produced anything to decide on. That is a
 * matter of not offering a control that would be refused — the refusal itself
 * comes from the service and the guard trigger behind it, not from this file.
 *
 * Two submit buttons on one form rather than two forms, so the pending state
 * disables both while a decision is in flight.
 */
export function RequirementDecisionForm({
  versionId,
  leadId,
}: {
  versionId: string;
  leadId: string;
}) {
  const [state, action, pending] = useActionState(decideRequirementVersionAction, IDLE_STATE);

  return (
    <form action={action} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="leadId" value={leadId} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="decision"
          value="accepted"
          disabled={pending}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          {pending ? 'Saving…' : 'Approve'}
        </button>
        <button
          type="submit"
          name="decision"
          value="rejected"
          disabled={pending}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          Reject
        </button>
      </div>

      {state.status !== 'idle' ? (
        <p
          role="status"
          className={`text-sm ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
