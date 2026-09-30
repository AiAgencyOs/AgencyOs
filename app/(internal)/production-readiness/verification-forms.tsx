'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass } from '@/ui';

import { runVerificationAction, testAlertDestinationAction } from './actions';
import { IDLE_VERIFICATION } from './verification-state';

/** SCR-067 "Run verification": one button, one report line per live check. */
export function RunVerificationForm() {
  const [state, action, pending] = useActionState(runVerificationAction, IDLE_VERIFICATION);

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Running the checks…' : 'Run verification'}
        </button>
        <span className="text-xs text-muted">Asks Meta, the AI provider, Google Calendar and Figma in turn. The AI check makes one small real call.</span>
      </div>
      {state.message ? <FormMessage status={state.status === 'error' ? 'error' : 'success'} message={state.message} className="text-xs" /> : null}
      {state.results ? (
        <ul className="flex flex-col gap-1 text-[13px]">
          {state.results.map((r) => (
            <li key={r.name} className="flex flex-wrap items-baseline gap-2">
              <Badge tone={r.status === 'ok' ? 'success' : r.status === 'failed' ? 'danger' : 'neutral'} dot>
                {r.status === 'ok' ? 'Answered' : r.status === 'failed' ? 'Failed' : 'Skipped'}
              </Badge>
              <span className="font-medium">{r.name}</span>
              <span className="min-w-0 break-words text-xs text-muted">{r.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

/** SCR-067 "Alert destination": fire one labelled test. */
export function TestAlertDestinationForm({ last }: { last: string }) {
  const [state, action, pending] = useActionState(testAlertDestinationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Sending the test…' : 'Test alert destination'}
      </button>
      <span className="text-xs text-muted">{last}</span>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
