'use client';

import { useActionState } from 'react';

import { startConversationAction } from '@/modules/crm/actions';
import { IDLE_STATE } from '@/modules/identity/types';

export function StartConversationForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(startConversationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
      >
        {pending ? 'Starting…' : 'Start requirement conversation'}
      </button>
      {state.status === 'error' ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
