'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass } from '@/ui';

import { revokeProviderCredentialAction } from './actions';

/**
 * SCR-064 — "Revoke" beside a vault row, on /agents and /agents/routing.
 *
 * Drawn only where the page already knows a key is stored, but the decision
 * is not the button's: `revokeProviderCredentialAction` refuses everybody but
 * the owner, `ai.revoke_provider_credential` refuses again, and the refusal
 * is shown as written. A browser confirm stands in front because a revoked
 * key cannot be shown again — the owner would have to fetch it from the
 * vendor to store it back.
 */
export function RevokeProviderCredentialForm({ provider }: { provider: string }) {
  const [state, action, pending] = useActionState(revokeProviderCredentialAction, IDLE_STATE);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Revoke the stored ${provider} key? Agents routed to ${provider} will stop running until a key is stored again.`)) e.preventDefault();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="provider" value={provider} />
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
