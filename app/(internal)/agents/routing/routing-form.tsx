'use client';

import { useActionState } from 'react';

import type { RoutingPolicyRow } from '@/lib/admin/model-routing';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

import { setRoutingPolicyAction } from './actions';

/** Mirrors ai.routing_policies' optimise_for CHECK — kept local so this client component never imports the server-only model-routing module for a value. */
const OPTIMISE_FOR = ['quality', 'cost', 'latency'] as const;

const CATEGORY_LABEL: Record<string, string> = {
  engineering: 'Engineering',
  coordination: 'Coordination',
  client_facing: 'Client-facing',
  extraction: 'Extraction',
  design: 'Design',
  money: 'Money',
  certification: 'Certification',
};

export function RoutingPolicyForm({ policy }: { policy: RoutingPolicyRow }) {
  const [state, action, pending] = useActionState(setRoutingPolicyAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      <input type="hidden" name="category" value={policy.category} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{CATEGORY_LABEL[policy.category] ?? policy.category}</span>
        <span className="text-xs text-muted">{policy.configured ? 'configured' : 'default'}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Optimise for</label>
          <select name="optimiseFor" defaultValue={policy.optimiseFor} className={selectClass}>
            {OPTIMISE_FOR.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label className={labelClass}>Preferred models (comma-separated, in order)</label>
          <input
            name="preferredModels"
            defaultValue={policy.preferredModels.join(', ')}
            className={inputClass}
            placeholder="claude-sonnet-5, gpt-5"
          />
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label className={labelClass}>Admin override (wins outright)</label>
          <input name="adminOverrideModel" defaultValue={policy.adminOverrideModel ?? ''} className={inputClass} />
        </div>
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
