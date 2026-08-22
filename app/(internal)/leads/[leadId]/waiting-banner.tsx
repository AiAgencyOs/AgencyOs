'use client';

import { useActionState } from 'react';

import { resumeAgentRepliesAction } from '@/modules/crm/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, IconAlert } from '@/ui';

/**
 * This conversation is waiting for a person — Doc 09 §7 and §36.
 *
 * At the top of the thread and impossible to scroll past, because the client
 * has already been told somebody is coming. The cost of this not being seen is
 * a person sitting in a silence AgencyOS created.
 *
 * The reason is the agent's own words rather than a category: *"the client
 * asked to speak to a person"* and *"they are asking for a commitment I cannot
 * make"* need different people, and a label loses that.
 *
 * The button is the only way back. It is deliberately not automatic and not
 * timed — whatever made the agent stop, a person decides it is over.
 */
export function WaitingForSomebody({
  conversationId,
  leadId,
  reason,
  since,
  mayWrite,
}: {
  conversationId: string;
  leadId: string;
  reason: string;
  since: string;
  mayWrite: boolean;
}) {
  const [state, action, pending] = useActionState(resumeAgentRepliesAction, IDLE_STATE);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/50 bg-warning/5 p-3">
      <p className="flex items-start gap-2 text-sm">
        <IconAlert size={15} className="mt-0.5 shrink-0 text-warning" label="" />
        <span>
          <span className="font-medium">This client is waiting for a person.</span>{' '}
          The agent stopped answering here — “{reason}” — and will not start again until
          somebody puts it back.
          <span className="block text-[12.5px] text-muted">Since {since}</span>
        </span>
      </p>

      {mayWrite ? (
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="conversationId" value={conversationId} />
          <input type="hidden" name="leadId" value={leadId} />
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Putting it back…' : 'Let the agent answer again'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </form>
      ) : null}
    </div>
  );
}
