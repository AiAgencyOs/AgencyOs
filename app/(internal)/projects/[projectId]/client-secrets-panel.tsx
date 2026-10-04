'use client';

import { useActionState } from 'react';

import { revealClientSecretAction, revokeClientSecretAction, storeClientSecretAction, type RevealState } from '@/modules/projects/client-secrets-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * What the client sent in confidence (ADM-106). Typed once into a password
 * field, encrypted before it leaves the server action, shown again only on an
 * explicit click that is recorded against the viewer. The value lives in this
 * component's state for the one view; leaving the page drops it.
 */

const KINDS: readonly [string, string][] = [
  ['login', 'Login'],
  ['api_key', 'API key'],
  ['hosting', 'Hosting access'],
  ['domain', 'Domain / DNS'],
  ['social', 'Social account'],
  ['other', 'Other'],
];

export function StoreClientSecretForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(storeClientSecretAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <span className={labelClass}>What is it</span>
          <input name="label" required maxLength={120} placeholder="Hosting login" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Kind</span>
          <select name="kind" defaultValue="other" className={selectClass}>
            {KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className={labelClass}>The secret</span>
          <input type="password" name="value" autoComplete="new-password" spellCheck={false} required className={inputClass} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Encrypting…' : 'Store encrypted'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function RevealClientSecretForm({ secretId }: { secretId: string }) {
  const [state, action, pending] = useActionState<RevealState, FormData>(revealClientSecretAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="secretId" value={secretId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Opening…' : 'Show (recorded)'}
      </button>
      {state.value ? (
        <code className="break-all rounded border border-line bg-surface-hover px-2 py-1 text-xs" data-testid="revealed-secret">
          {state.value}
        </code>
      ) : null}
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function RevokeClientSecretForm({ projectId, secretId, label }: { projectId: string; secretId: string; label: string }) {
  const [state, action, pending] = useActionState(revokeClientSecretAction, IDLE_STATE);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Revoke “${label}”? The value is deleted and cannot be shown again.`)) e.preventDefault();
      }}
      className="flex flex-col gap-1"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="secretId" value={secretId} />
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
