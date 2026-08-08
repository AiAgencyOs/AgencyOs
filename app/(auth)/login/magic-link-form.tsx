'use client';

import { useActionState } from 'react';

import { sendMagicLinkAction } from '@/modules/identity/actions';
import { IDLE_STATE } from '@/modules/identity/types';

export function MagicLinkForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(sendMagicLinkAction, IDLE_STATE);

  if (state.status === 'success') {
    return (
      <div
        role="status"
        className="rounded-lg border border-emerald-600/30 bg-emerald-500/10 px-4 py-3 text-sm"
      >
        {state.message}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />

      <label htmlFor="email" className="text-sm font-medium">
        Client email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        placeholder="you@company.com"
        aria-describedby={state.fieldErrors?.['email'] ? 'email-error' : undefined}
        aria-invalid={state.fieldErrors?.['email'] ? true : undefined}
        className="rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
      />

      {state.fieldErrors?.['email'] ? (
        <p id="email-error" className="text-sm text-red-600 dark:text-red-400">
          {state.fieldErrors['email'].join(' ')}
        </p>
      ) : null}

      {state.status === 'error' && state.message && !state.fieldErrors ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Sending…' : 'Email me a sign-in link'}
      </button>
    </form>
  );
}
