'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { commentOnRequirementAction } from '@/modules/projects/requirement-comments-actions';
import { buttonClass, FormMessage, labelClass, textareaClass } from '@/ui';

/** "Add Comment" — appends a note to the requirement through `projects.comment_on_scope_item`. */
export function RequirementCommentForm({ projectId, scopeItemId }: { projectId: string; scopeItemId: string }) {
  const [state, action, pending] = useActionState(commentOnRequirementAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} key={state.status === 'success' ? `${scopeItemId}-sent` : scopeItemId} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <label htmlFor={id} className={labelClass}>Add Comment</label>
      <textarea id={id} name="body" required maxLength={2000} rows={3} className={textareaClass} placeholder="Say something about this requirement…" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Adding…' : 'Add Comment'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
