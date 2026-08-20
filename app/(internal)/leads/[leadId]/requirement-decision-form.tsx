'use client';

import { useActionState } from 'react';

import { decideRequirementVersionAction } from '@/modules/crm/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, IconCheck, IconClose } from '@/ui';

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
    <form action={action} className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="leadId" value={leadId} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="decision"
          value="accepted"
          disabled={pending}
          className={buttonClass('primary', 'sm')}
        >
          <IconCheck size={15} />
          {pending ? 'Saving…' : 'Approve'}
        </button>
        <button
          type="submit"
          name="decision"
          value="rejected"
          disabled={pending}
          className={buttonClass('secondary', 'sm')}
        >
          <IconClose size={15} />
          Reject
        </button>
      </div>

      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
