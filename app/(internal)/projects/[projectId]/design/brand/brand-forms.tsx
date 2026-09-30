'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { addBrandRuleAction, removeBrandRuleAction } from '@/modules/projects/brand-kit-actions';
import { buttonClass, FormMessage, inputClass, labelClass, textareaClass } from '@/ui';

/** "Add a brand rule" — `projects.add_brand_rule`. */
export function AddBrandRuleForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addBrandRuleAction, IDLE_STATE);
  const titleId = useId();
  const ruleId = useId();
  return (
    <form action={action} key={state.status === 'success' ? 'added' : 'add'} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label htmlFor={titleId} className={labelClass}>Rule name</label>
      <input id={titleId} name="title" required maxLength={120} className={inputClass} placeholder="e.g. Logo clear space" />
      <label htmlFor={ruleId} className={labelClass}>The rule</label>
      <textarea id={ruleId} name="rule" required maxLength={2000} rows={3} className={textareaClass} placeholder="Keep clear space equal to the height of the logo mark on every side." />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Adding…' : 'Add Brand Rule'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function RemoveBrandRuleButton({ projectId, ruleId, title }: { projectId: string; ruleId: string; title: string }) {
  const [state, action, pending] = useActionState(removeBrandRuleAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="ruleId" value={ruleId} />
      <button type="submit" disabled={pending} aria-label={`Remove the brand rule ${title}`} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
