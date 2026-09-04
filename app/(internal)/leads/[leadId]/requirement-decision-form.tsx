'use client';

import { useActionState } from 'react';

import {
  decideRequirementVersionAction,
  sendRequirementForConfirmationAction,
} from '@/modules/crm/actions';
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
  sentForConfirmationAt,
}: {
  versionId: string;
  leadId: string;
  /** G-200 — when the client was shown this, or null if they never were. */
  sentForConfirmationAt: string | null;
}) {
  const [state, action, pending] = useActionState(decideRequirementVersionAction, IDLE_STATE);

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
      <ConfirmationSendForm
        versionId={versionId}
        leadId={leadId}
        sentForConfirmationAt={sentForConfirmationAt}
      />

    <form action={action} className="flex flex-col gap-2">
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
    </div>
  );
}

/**
 * Doc §12's client confirmation step — G-200.
 *
 * Above the approve/reject buttons rather than beside them, because it is the
 * step that comes first: the question is whether the client has seen this,
 * and a person deciding should read that before they read their own options.
 *
 * When they have not been shown it, the line says so plainly. It does not
 * BLOCK approval — a scope agreed on a phone call is agreed, and refusing to
 * record it would push the truth out of the system to protect a checkbox.
 */
function ConfirmationSendForm({
  versionId,
  leadId,
  sentForConfirmationAt,
}: {
  versionId: string;
  leadId: string;
  sentForConfirmationAt: string | null;
}) {
  const [state, action, pending] = useActionState(sendRequirementForConfirmationAction, IDLE_STATE);

  if (sentForConfirmationAt) {
    return (
      <p className="text-xs text-muted">
        Sent to the client for confirmation. Their reply is on the thread below — read it before
        approving; nothing here reads it for you.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="leadId" value={leadId} />
      <p className="text-xs text-muted">
        The client has not been shown this summary. You can approve it anyway — but if they have
        not seen it, they are about to be quoted against a scope they never read.
      </p>
      <div>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Sending…' : 'Send to client for confirmation'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
