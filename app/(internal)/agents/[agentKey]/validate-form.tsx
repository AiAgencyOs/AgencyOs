'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { validateAgentConfigurationAction } from '@/modules/agents/validation-actions';
import { FormMessage, buttonClass } from '@/ui';

/**
 * SCR-062 — "Validate now". Drawn for whoever may see the page; whether this
 * caller may validate is decided in `validateAgentConfiguration` (owner or
 * ops admin) and again by the insert policy, and the refusal is shown.
 */
export function ValidateAgentForm({ agentKey }: { agentKey: string }) {
  const [state, action, pending] = useActionState(validateAgentConfigurationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="agentKey" value={agentKey} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Checking…' : 'Validate now'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
