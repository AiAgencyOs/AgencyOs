'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { raiseRequirementClarificationAction } from '@/modules/projects/requirement-clarifications-actions';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-041 "Request clarification" without a plan: the question is asked of
 * one of the requirements the task's feature delivers
 * (`projects.raise_requirement_clarification`), so it reaches the
 * requirement and its open-question queue whether or not a plan exists.
 */
export function TaskRequirementClarificationForm({ projectId, taskTitle, items }: { projectId: string; taskTitle: string; items: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState(raiseRequirementClarificationAction, IDLE_STATE);
  const ids = { item: useId(), question: useId(), impact: useId() };
  return (
    <form action={action} key={state.status === 'success' ? 'asked' : 'ask'} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label htmlFor={ids.item} className={labelClass}>Requirement</label>
      <select id={ids.item} name="scopeItemId" required defaultValue={items[0]?.id ?? ''} className={selectClass}>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.title}
          </option>
        ))}
      </select>
      <label htmlFor={ids.question} className={labelClass}>The question</label>
      <input id={ids.question} name="question" required maxLength={1000} className={inputClass} placeholder={`About "${taskTitle.slice(0, 60)}"`} />
      <label htmlFor={ids.impact} className={labelClass}>What it changes if the answer goes either way</label>
      <input id={ids.impact} name="impact" required maxLength={1000} className={inputClass} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Requesting…' : 'Request Clarification'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
