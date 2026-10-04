'use client';

import { useActionState } from 'react';

import { confirmUnsubscribeAction, type UnsubscribeState } from './actions';

export function UnsubscribeButton({ token }: { token: string }) {
  const [state, action, pending] = useActionState<UnsubscribeState, FormData>(confirmUnsubscribeAction, { status: 'idle' });
  if (state.status === 'done') return <p className="rounded-md border border-line bg-surface px-3 py-2 text-sm">You are unsubscribed. We will not email you again.</p>;
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="token" value={token} />
      <button type="submit" disabled={pending} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-60">
        {pending ? 'Unsubscribing…' : 'Yes, unsubscribe me'}
      </button>
      {state.status === 'error' ? <p className="text-sm text-danger">{state.message}</p> : null}
    </form>
  );
}
