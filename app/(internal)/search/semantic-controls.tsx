'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage } from '@/ui';

import { startSemanticBackfillAction, stopSemanticAction } from './search-actions';

/**
 * The owner's confirm step for turning search by meaning on: the estimate was
 * shown above this form, and the button is the only thing that spends. The
 * hidden field carries the record count the estimate was made for.
 */
export function ConfirmBackfillForm({ records, cancelHref }: { records: number; cancelHref: string }) {
  const [state, action, pending] = useActionState(startSemanticBackfillAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="records" value={records} />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Starting…' : 'Confirm and start indexing'}
      </button>
      <Link href={cancelHref} className={buttonClass('secondary', 'sm')}>
        Cancel
      </Link>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

/** Turns search by meaning off. Existing vectors are kept; nothing more is spent. */
export function StopSemanticForm() {
  const [state, action, pending] = useActionState(stopSemanticAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Turning off…' : 'Turn off search by meaning'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
