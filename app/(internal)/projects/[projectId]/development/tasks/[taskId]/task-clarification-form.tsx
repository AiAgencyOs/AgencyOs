'use client';

import { useActionState } from 'react';

import { raiseClarificationAction } from '@/modules/projects/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * "Request clarification from a task" — SCR-041. The same door the plan
 * page's `RaiseClarificationForm` calls (`projects.raise_clarification`),
 * pre-filled with the task's title so the question names what it is about.
 * The door refuses `not_draft`: a question is raised on the plan being
 * drafted, never on a live one (Project Planning §10), and the page only
 * offers this form when the newest plan is a draft.
 */
export function TaskClarificationForm({
  projectId,
  planId,
  taskTitle,
}: {
  projectId: string;
  planId: string;
  taskTitle: string;
}) {
  const [state, action, pending] = useActionState(raiseClarificationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-dashed border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor="task-question">
          The question — asked, not guessed
        </label>
        <input
          id="task-question"
          name="question"
          required
          maxLength={2000}
          defaultValue={`About “${taskTitle}”: `}
          className={inputClass}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor="task-impact">
          What it affects if the answer goes either way
        </label>
        <input id="task-impact" name="impact" required maxLength={2000} className={inputClass} />
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Raising…' : 'Raise on the plan'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
