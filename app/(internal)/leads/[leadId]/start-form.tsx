'use client';

import { useActionState } from 'react';

import { startConversationAction } from '@/modules/crm/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, IconLeads } from '@/ui';

export function StartConversationForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(startConversationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col items-center gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <button type="submit" disabled={pending} className={buttonClass('whatsapp', 'md')}>
        <IconLeads size={16} />
        {pending ? 'Starting…' : 'Start requirement conversation'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
