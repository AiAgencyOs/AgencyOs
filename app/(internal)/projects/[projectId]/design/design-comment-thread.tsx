import type { DesignReviewComment } from '@/modules/projects/design-review-comments-queries';

import { DesignCommentForm } from './design-comment-form';

/** SCR-036 — the comment thread on one design option or deliverable: who said what and when, oldest first, and the form. */
export function DesignCommentThread({
  projectId,
  subjectType,
  subjectId,
  comments,
  canComment,
  formatDateTime,
}: {
  projectId: string;
  subjectType: 'theme_option' | 'deliverable';
  subjectId: string;
  comments: DesignReviewComment[];
  canComment: boolean;
  formatDateTime: (iso: string) => string;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2">
      <span className="text-xs text-muted">Comments ({comments.length})</span>
      {comments.length === 0 ? (
        <p className="text-[13px] text-muted">No comment yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md border border-line px-3 py-1.5 text-[13px]">
              <p className="flex flex-wrap items-baseline gap-2 text-xs text-muted">
                <span className="font-semibold text-foreground">{c.authorName}</span>
                {formatDateTime(c.createdAt)}
              </p>
              <p className="whitespace-pre-wrap">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {canComment ? <DesignCommentForm projectId={projectId} subjectType={subjectType} subjectId={subjectId} /> : null}
    </div>
  );
}
