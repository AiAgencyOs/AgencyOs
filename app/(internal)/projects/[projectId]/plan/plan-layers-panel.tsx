'use client';

import { useActionState } from 'react';

import { setPlanLayersAction } from '@/modules/projects/plan-layers-actions';
import { LAYER_STATUSES, PLAN_LAYER_LABEL, PLAN_LAYERS, type PlanLayersRecord } from '@/modules/projects/plan-layers-types';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-040 — one deliverable's seven layers and its execution order, edited
 * in place (`projects.set_plan_layers`, migration 20261001130000). A layer
 * left "not applicable" says so rather than pretending to be planned.
 */
export function PlanLayersPanel({ projectId, planDeliverableId, current }: { projectId: string; planDeliverableId: string; current: PlanLayersRecord | null }) {
  const [state, action, pending] = useActionState(setPlanLayersAction, IDLE_STATE);
  return (
    <details className="rounded-md border border-line">
      <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium">Layers and execution order</summary>
      <form action={action} className="flex flex-col gap-3 border-t border-line p-3">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="planDeliverableId" value={planDeliverableId} />
        <div className="grid gap-2 sm:grid-cols-2">
          {PLAN_LAYERS.map((layer) => {
            const entry = current?.layers[layer];
            return (
              <div key={layer} className="flex flex-col gap-1 rounded-md border border-line p-2">
                <label className={labelClass}>{PLAN_LAYER_LABEL[layer]}</label>
                <select name={`layer.${layer}.status`} defaultValue={entry?.status ?? 'planned'} className={selectClass}>
                  {LAYER_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {st.replace('_', ' ')}
                    </option>
                  ))}
                </select>
                <input name={`layer.${layer}.note`} maxLength={500} defaultValue={entry?.note ?? ''} className={inputClass} placeholder="What this layer covers (optional)" />
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Execution order</label>
            <input name="executionOrder" type="number" min={1} max={999} defaultValue={current?.executionOrder ?? ''} className={inputClass} placeholder="1, 2, 3…" />
          </div>
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Saving…' : 'Save layers'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      </form>
    </details>
  );
}
