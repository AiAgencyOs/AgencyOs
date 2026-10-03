import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { commentOnRequirementSchema, type CommentOnRequirementInput } from './requirement-comments-schema';

/**
 * The requirement comment door. `task.write` here (the capability every
 * project writer has), and `projects.comment_on_scope_item` re-checks the
 * role in the database and writes the audit row — there is no direct write
 * on the table at all.
 */
export async function commentOnRequirement(input: CommentOnRequirementInput): Promise<Result<{ commentId: string }>> {
  const parsed = commentOnRequirementSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid comment.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to comment on a requirement.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('comment_on_scope_item', {
    p_scope_item_id: parsed.data.scopeItemId,
    p_body: parsed.data.body,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'commentOnRequirement', detail: error.message }));
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
      return err('NOT_FOUND', 'That requirement is not visible to you.');
    default:
      return err('FORBIDDEN', 'You do not have permission to comment on a requirement.');
  }
}
