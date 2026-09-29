'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

import { setAgentRoutingOverrideAction } from './override-actions';

/**
 * One form for the whole grid — SCR-064. A cell is a link that prefills
 * agent and category here (`?agent=&category=`), so the grid stays a table a
 * reader can scan rather than ninety-one forms. Save with an empty list, or
 * Clear, deletes the override; the door decides, the refusal is shown.
 */
export function RoutingOverrideForm({
  agents,
  categories,
  initial,
}: {
  agents: readonly { key: string; displayName: string }[];
  categories: readonly string[];
  initial: { agentKey: string; category: string; preferredModels: string[]; note: string | null };
}) {
  const [state, action, pending] = useActionState(setAgentRoutingOverrideAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap gap-2">
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="override-agent">
            Agent
          </label>
          <select id="override-agent" name="agentKey" defaultValue={initial.agentKey} className={selectClass}>
            {agents.map((a) => (
              <option key={a.key} value={a.key}>
                {a.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="override-category">
            Category
          </label>
          <select id="override-category" name="category" defaultValue={initial.category} className={selectClass}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <label className={labelClass} htmlFor="override-models">
            Preferred models (comma-separated, in order)
          </label>
          <input
            id="override-models"
            name="preferredModels"
            defaultValue={initial.preferredModels.join(', ')}
            className={inputClass}
            placeholder="the first one a registered provider serves wins"
          />
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label className={labelClass} htmlFor="override-note">
            Note
          </label>
          <input id="override-note" name="note" defaultValue={initial.note ?? ''} maxLength={500} className={inputClass} placeholder="why this agent differs" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" name="intent" value="set" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Set override'}
        </button>
        <button type="submit" name="intent" value="clear" disabled={pending} className={buttonClass('ghost', 'sm')}>
          Clear
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
