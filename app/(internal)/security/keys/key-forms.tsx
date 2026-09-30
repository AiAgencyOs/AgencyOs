'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

import { revokeProviderCredentialAction, setProviderCredentialAction } from '../../settings/actions';
import { revokeSecretAction, storeSecretAction, verifySecretAction } from './actions';

/**
 * The three controls a key row can carry. Each is a form over a server
 * action; the doors refuse everyone but the owner (store, revoke) or an admin
 * (verify) and the refusal is shown as written. The value is typed into a
 * password field, sent once and never returned: no field on this screen is
 * ever pre-filled with a stored key.
 */

export function StoreSecretForm({
  slot,
  label,
  canExpire,
  replace,
  providerVault,
  whereToGetIt,
}: {
  slot: string;
  label: string;
  canExpire?: boolean;
  /** A key is already stored: the form replaces it, and says so. */
  replace: boolean;
  /** An AI provider key goes through the older provider vault's own door. */
  providerVault?: string;
  whereToGetIt?: string;
}) {
  const [state, action, pending] = useActionState(providerVault ? setProviderCredentialAction : storeSecretAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      {providerVault ? <input type="hidden" name="provider" value={providerVault} /> : <input type="hidden" name="slot" value={slot} />}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className={labelClass}>{replace ? `New ${label} (replaces the stored one)` : label}</span>
          <input type="password" name={providerVault ? 'key' : 'value'} autoComplete="new-password" spellCheck={false} required className={inputClass} />
        </label>
        {canExpire && !providerVault ? (
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Expires on (optional)</span>
            <input type="date" name="expiresOn" className={inputClass} />
          </label>
        ) : null}
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Encrypting…' : replace ? 'Replace key' : 'Store key'}
        </button>
      </div>
      {whereToGetIt ? <p className="text-xs text-muted">Where to get it: {whereToGetIt}</p> : null}
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function RevokeSecretForm({ slot, label, providerVault }: { slot: string; label: string; providerVault?: string }) {
  const [state, action, pending] = useActionState(providerVault ? revokeProviderCredentialAction : revokeSecretAction, IDLE_STATE);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Revoke the stored ${label}? Whatever uses it stops working until a key is stored again, and this key cannot be shown again.`)) e.preventDefault();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      {providerVault ? <input type="hidden" name="provider" value={providerVault} /> : <input type="hidden" name="slot" value={slot} />}
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function VerifySecretForm({ slot }: { slot: string }) {
  const [state, action, pending] = useActionState(verifySecretAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="slot" value={slot} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Asking the vendor…' : 'Verify'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
