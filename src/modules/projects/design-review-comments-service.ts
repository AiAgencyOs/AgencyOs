import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { commentOnDesignReviewSchema, type CommentOnDesignReviewInput } from './design-review-comments-schema';

/** SCR-036 — the comment thread door. `task.write` here; `projects.comment_on_design_review` re-checks `core.can_write()` and audits. */
export async function commentOnDesignReview(input: CommentOnDesignReviewInput): Promise<Result<{ commentId: string }>> {
  const parsed = commentOnDesignReviewSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid comment.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to comment on a design.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('comment_on_design_review', {
    p_subject_type: parsed.data.subjectType,
    p_subject_id: parsed.data.subjectId,
    p_body: parsed.data.body,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'commentOnDesignReview', detail: error.message }));
    return err('INTERNAL', 'Could not add the comment.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; comment_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'commented':
      return row.comment_id ? ok({ commentId: row.comment_id }) : err('INTERNAL', 'Could not add the comment.');
    case 'empty':
      return err('VALIDATION', 'Write a comment first.');
    case 'too_long':
      return err('VALIDATION', 'A comment is at most 2000 characters.');
    case 'not_found':
    case 'bad_subject':
      return err('NOT_FOUND', 'That design is not visible to you.');
    default:
      return err('FORBIDDEN', 'The database refused: only a writing role may comment.');
  }
}
