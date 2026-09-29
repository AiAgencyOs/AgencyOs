import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { recordAccessReviewSchema, type RecordAccessReviewInput } from './access-reviews-schema';

/**
 * SCR-069 — a person reviews a membership's access. `organization.settings`
 * here (the same gate the users & roles page carries), `core.is_admin()`
 * again inside `security.record_access_review`; audited as access.reviewed.
 */
export async function recordAccessReview(input: RecordAccessReviewInput): Promise<Result<{ id: string; decision: string }>> {
  const parsed = recordAccessReviewSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid review.');

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to review access.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('security').rpc('record_access_review', {
    p_membership_id: parsed.data.membershipId,
    p_decision: parsed.data.decision,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordAccessReview', detail: error.message }));
    return err('INTERNAL', 'Could not record the review.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'recorded':
      return ok({ id: row.id as string, decision: parsed.data.decision });
    case 'note_required':
      return err('VALIDATION', 'Asking for access to go needs a note saying why.');
    case 'not_a_member':
      return err('VALIDATION', 'That person is not on this organisation’s roster.');
    case 'bad_decision':
      return err('VALIDATION', 'Not a decision this system records.');
    default:
      return err('FORBIDDEN', 'You do not have permission to review access.');
  }
}
