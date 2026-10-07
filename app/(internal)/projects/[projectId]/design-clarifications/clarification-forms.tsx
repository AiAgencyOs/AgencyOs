'use client';

import { useActionState, useId } from 'react';

import { answerClarificationAction, markClarificationAskedAction } from '@/modules/projects/p13-design-clarification-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, textareaClass } from '@/ui';

export function AskedForm({ id, projectId }: { id: string; projectId: string }) {
  const [state, action, pending] = useActionState(markClarificationAskedAction, IDLE_STATE);
  const n = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor={`${n}-v`} className={labelClass}>
          Asked by
        </label>
        <select id={`${n}-v`} name="via" className={inputClass} defaultValue="whatsapp">
          <option value="whatsapp">WhatsApp</option>
          <option value="email">Email</option>
          <option value="call">Call</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor={`${n}-e`} className={labelClass}>
          Message reference
        </label>
        <input id={`${n}-e`} name="evidence" required maxLength={300} className={inputClass} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Record: client asked'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function AnswerForm({ id, projectId }: { id: string; projectId: string }) {
  const [state, action, pending] = useActionState(answerClarificationAction, IDLE_STATE);
  const n = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="projectId" value={projectId} />
      <label htmlFor={`${n}-a`} className={labelClass}>
        The client's answer, in their words
      </label>
      <textarea id={`${n}-a`} name="answer" required rows={3} maxLength={4000} className={textareaClass} />
      <label htmlFor={`${n}-f`} className={labelClass}>
        Structured fields (optional JSON object)
      </label>
      <input id={`${n}-f`} name="fields" className={inputClass} placeholder='{"guest_checkout": true}' />
      <label htmlFor={`${n}-r`} className={labelClass}>
        Where to read it (message reference)
      </label>
      <input id={`${n}-r`} name="evidence" required maxLength={300} className={inputClass} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Record the answer'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
