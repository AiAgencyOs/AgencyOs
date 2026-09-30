'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { commentOnDesignReviewAction } from '@/modules/projects/design-review-comments-actions';
import { buttonClass, FormMessage, labelClass, textareaClass } from '@/ui';

/** "Add comment" on a design under review — `projects.comment_on_design_review`. */
export function DesignCommentForm({ projectId, subjectType, subjectId }: { projectId: string; subjectType: 'theme_option' | 'deliverable'; subjectId: string }) {
  const [state, action, pending] = useActionState(commentOnDesignReviewAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} key={state.status === 'success' ? `${subjectId}-sent` : subjectId} className="flex flex-col gap-1.5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="subjectType" value={subjectType} />
      <input type="hidden" name="subjectId" value={subjectId} />
      <label htmlFor={id} className={labelClass}>Add a comment</label>
      <textarea id={id} name="body" required maxLength={2000} rows={2} className={textareaClass} placeholder="Say something about this design…" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Adding…' : 'Add Comment'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
