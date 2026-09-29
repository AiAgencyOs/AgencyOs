'use client';

import { useActionState } from 'react';

import { setAgentCapsAction, setAgentStatusAction } from '@/modules/agents/controls-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * ADM-82 — Decision: reversed by the owner on 2026-09-29. The owner's two
 * controls on a registry agent: enable/disable (a disable says why) and the
 * per-run ceilings. Rendered only for the owner; the doors refuse everyone
 * else and RLS has nothing to add because the write is a SECURITY DEFINER
 * function that checks the role itself. Refusals are shown verbatim.
 */

export function AgentStatusForm({ agentKey, enabled }: { agentKey: string; enabled: boolean }) {
  const [state, action, pending] = useActionState(setAgentStatusAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="agentKey" value={agentKey} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      {enabled ? (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Reason for disabling</span>
          <input name="reason" required maxLength={500} placeholder="Why this agent is being switched off" className={inputClass} />
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass(enabled ? 'danger' : 'primary', 'sm')}>
          {pending ? '…' : enabled ? 'Disable agent' : 'Enable agent'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export function AgentCapsForm({ agentKey, maxSteps, maxCostMinor }: { agentKey: string; maxSteps: number | null; maxCostMinor: number | null }) {
  const [state, action, pending] = useActionState(setAgentCapsAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="agentKey" value={agentKey} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Max steps per run</span>
        <input type="number" name="maxSteps" min={1} max={1000} step={1} required defaultValue={maxSteps ?? ''} className={`${inputClass} w-32`} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Max cost per run (₹)</span>
        <input
          type="number"
          name="maxCostRupees"
          min={0.01}
          max={1_000_000}
          step={0.01}
          required
          defaultValue={maxCostMinor !== null ? (maxCostMinor / 100).toFixed(2) : ''}
          className={`${inputClass} w-36`}
        />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Set ceilings'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}
