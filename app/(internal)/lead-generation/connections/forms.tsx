'use client';

import { useActionState } from 'react';

import { registerIntegrationAction, setIntegrationStateAction, storeSecretAction, testConnectionAction } from '@/modules/acquisition/actions';
import { PROVIDERS, PROVIDER_CATALOG, PROVIDER_ENVIRONMENTS } from '@/modules/acquisition/providers';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function AddConnectionForm() {
  const [state, action, pending] = useActionState(registerIntegrationAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
      <Field label="Provider">
        <select name="provider" aria-label="Provider" required className={selectClass}>
          {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_CATALOG[p].label}</option>)}
        </select>
      </Field>
      <Field label="Environment" hint="Keep test and live accounts apart.">
        <select name="environment" aria-label="Environment" defaultValue="production" className={selectClass}>
          {PROVIDER_ENVIRONMENTS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </Field>
      <Field label="Label" hint="Only if you connect two accounts.">
        <input name="label" maxLength={60} placeholder="default" className={inputClass} />
      </Field>
      <button type="submit" disabled={pending} className={buttonClass('primary')}>Add connection</button>
      <div className="sm:col-span-4"><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

/** The value goes straight to the server, is encrypted there and is never shown again - this field is write-only. */
export function StoreSecretForm({ integrationId, names, canStore }: { integrationId: string; names: readonly string[]; canStore: boolean }) {
  const [state, action, pending] = useActionState(storeSecretAction, IDLE_STATE);
  if (!canStore) return <p className="text-xs text-muted">Only the owner can store a credential.</p>;
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
      <input type="hidden" name="integrationId" value={integrationId} />
      <Field label="Credential">
        <select name="name" aria-label="Credential" className={selectClass}>{names.map((n) => <option key={n} value={n}>{n}</option>)}</select>
      </Field>
      <Field label="Value" hint="Enter it here, not in chat. It is encrypted and cannot be viewed again.">
        <input name="value" type="password" autoComplete="off" required minLength={8} className={inputClass} />
      </Field>
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>Store securely</button>
      <div className="sm:col-span-3"><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export function TestConnectionButton({ integrationId }: { integrationId: string }) {
  const [state, action, pending] = useActionState(testConnectionAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="integrationId" value={integrationId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>{pending ? 'Testing...' : 'Test connection'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function IntegrationStateForm({ integrationId, status, isOwner }: { integrationId: string; status: string; isOwner: boolean }) {
  const [state, action, pending] = useActionState(setIntegrationStateAction, IDLE_STATE);
  if (status === 'REVOKED') return <p className="text-xs text-muted">Revoked. It cannot come back; add a new connection.</p>;
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <input type="hidden" name="integrationId" value={integrationId} />
      <div className="flex-1"><Field label="Reason"><input name="reason" required maxLength={500} className={inputClass} /></Field></div>
      {status === 'DISABLED' ? (
        <button type="submit" name="to" value="CONFIGURED" disabled={pending} className={buttonClass('primary')}>Re-enable</button>
      ) : (
        <button type="submit" name="to" value="DISABLED" disabled={pending} className={buttonClass('secondary')}>Disable</button>
      )}
      {isOwner ? <button type="submit" name="to" value="REVOKED" disabled={pending} className={buttonClass('danger')}>Revoke</button> : null}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
