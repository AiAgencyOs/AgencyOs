'use client';

import { useActionState, useId, useState } from 'react';

import { LEAD_SCORE_WEIGHT_KEYS, type LeadScoreWeights } from '@/modules/crm/lead-score';
import { setLeadScoreWeightsAction } from '@/modules/crm/lead-score-weights-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass } from '@/ui';

const LABELS: Record<keyof LeadScoreWeights, string> = {
  coverage_max: 'Qualification coverage (all areas covered)',
  budget_known: 'Budget is known',
  decision_maker: 'Contact is the decision-maker',
  timeline_stated: 'Timeline stated',
  engagement_some: 'Engagement: one or two replies',
  engagement_many: 'Engagement: three or more replies',
  recency_fresh: 'Recency: active in the last two days',
  recency_recent: 'Recency: active in the last week',
  deal_value: 'An open deal with a value',
  referral: 'Came by referral',
  stale_penalty: 'Penalty: new or qualifying for over 60 days',
};

/** The eight positive maxima must add up to 100; the total is shown as you type, and the database checks it again. */
const COUNTED = ['coverage_max', 'budget_known', 'decision_maker', 'timeline_stated', 'engagement_many', 'recency_fresh', 'deal_value', 'referral'] as const;

export function WeightsForm({ weights, readOnly }: { weights: LeadScoreWeights; readOnly: boolean }) {
  const [state, action, pending] = useActionState(setLeadScoreWeightsAction, IDLE_STATE);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(LEAD_SCORE_WEIGHT_KEYS.map((k) => [k, String(weights[k])])));
  const id = useId();
  const total = COUNTED.reduce((sum, k) => sum + (Number(values[k]) || 0), 0);
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {LEAD_SCORE_WEIGHT_KEYS.map((k) => (
          <div key={k} className="flex flex-col gap-1">
            <label htmlFor={`${id}-${k}`} className={labelClass}>
              {LABELS[k]}
            </label>
            <input
              id={`${id}-${k}`}
              name={k}
              type="number"
              min={0}
              max={k === 'stale_penalty' ? 50 : 100}
              step={1}
              value={values[k]}
              disabled={readOnly}
              onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
              className={inputClass}
            />
          </div>
        ))}
      </div>
      <p className={`text-[13px] ${total === 100 ? 'text-muted' : 'text-danger'}`}>
        The eight positive weights add up to {total}. They must add up to 100.
      </p>
      {readOnly ? (
        <p className="text-[13px] text-muted">Only an owner or ops admin can change the weights.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-reason`} className={labelClass}>
              Why are the weights changing?
            </label>
            <input id={`${id}-reason`} name="reason" required maxLength={500} className={inputClass} />
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={pending || total !== 100} className={buttonClass('primary', 'sm')}>
              {pending ? 'Saving…' : 'Save as a new version'}
            </button>
            <FormMessage status={state.status} message={state.message} />
          </div>
        </>
      )}
    </form>
  );
}
