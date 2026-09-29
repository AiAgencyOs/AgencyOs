'use client';

import { useActionState } from 'react';

import { WORK_CLASSES } from '@/lib/ai/autonomy';
import { setAgentWorkClassesAction } from '@/modules/agents/work-classes-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, labelClass } from '@/ui';

/**
 * SCR-063 — the owner's "allowed work classes" for one registry agent.
 * Tick none to lift the restriction. Owner only; the door refuses everyone
 * else and the refusal is shown as written.
 */
export function AgentWorkClassesForm({ agentKey, allowed }: { agentKey: string; allowed: readonly string[] }) {
  const [state, action, pending] = useActionState(setAgentWorkClassesAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="agentKey" value={agentKey} />
      <span className={labelClass}>Allowed work classes (none ticked = every class)</span>
      <div className="flex flex-wrap gap-3 text-[13px]">
        {WORK_CLASSES.map((w) => (
          <label key={w} className="flex items-center gap-1.5">
            <input type="checkbox" name="workClasses" value={w} defaultChecked={allowed.includes(w)} />
            {w.replace('_', ' ')}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Set allowed work'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}
