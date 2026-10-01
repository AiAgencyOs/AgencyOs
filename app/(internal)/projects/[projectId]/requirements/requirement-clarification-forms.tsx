'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { answerRequirementClarificationAction, raiseRequirementClarificationAction } from '@/modules/projects/requirement-clarifications-actions';
import { buttonClass, FormMessage, inputClass, labelClass, textareaClass } from '@/ui';

/** "Request clarification" on one requirement — `projects.raise_requirement_clarification`; needs no plan. */
export function RaiseClarificationForm({ projectId, scopeItemId }: { projectId: string; scopeItemId: string }) {
  const [state, action, pending] = useActionState(raiseRequirementClarificationAction, IDLE_STATE);
  const questionId = useId();
  const impactId = useId();
  return (
    <form action={action} key={state.status === 'success' ? `${scopeItemId}-asked` : scopeItemId} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <label htmlFor={questionId} className={labelClass}>The question for the client</label>
      <textarea id={questionId} name="question" required maxLength={1000} rows={2} className={textareaClass} />
      <label htmlFor={impactId} className={labelClass}>What it changes if the answer goes either way</label>
      <input id={impactId} name="impact" required maxLength={1000} className={inputClass} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Requesting…' : 'Request Clarification'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/** Records the answer the client gave to an open question. */
export function AnswerClarificationForm({ projectId, clarificationId }: { projectId: string; clarificationId: string }) {
  const [state, action, pending] = useActionState(answerRequirementClarificationAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="clarificationId" value={clarificationId} />
      <label htmlFor={id} className={labelClass}>What the client answered</label>
      <textarea id={id} name="answer" required maxLength={2000} rows={2} className={textareaClass} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Recording…' : 'Record Answer'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
