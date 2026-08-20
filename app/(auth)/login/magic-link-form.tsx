'use client';

import { useActionState } from 'react';

import { sendMagicLinkAction } from '@/modules/identity/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Callout, inputClass } from '@/ui';

export function MagicLinkForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(sendMagicLinkAction, IDLE_STATE);

  if (state.status === 'success') {
    return (
      <div role="status">
        <Callout tone="success">{state.message}</Callout>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2.5">
      <input type="hidden" name="next" value={next} />

      <label htmlFor="email" className="sr-only">
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
        className={inputClass}
      />

      {state.fieldErrors?.['email'] ? (
        <p id="email-error" className="text-[13px] text-danger">
          {state.fieldErrors['email'].join(' ')}
        </p>
      ) : null}

      {state.status === 'error' && state.message && !state.fieldErrors ? (
        <p role="alert" className="text-[13px] text-danger">
          {state.message}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={buttonClass('primary', 'md', 'w-full')}>
        {pending ? 'Sending…' : 'Email me a sign-in link'}
      </button>
    </form>
  );
}
