import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  MEETABLE_MILESTONE_STATUSES,
  markMilestoneMetSchema,
  type MarkMilestoneMetInput,
} from './milestone-schema';

/**
 * Mark a payment milestone met — the explicit door SCR-023 asks for.
 *
 * `milestone.write`, the capability every other writer of
 * `projects.milestones` takes, and `milestones_write`
 * (`core.can_manage_delivery()`) decides again at the row.
 *
 * Only `in_progress` or `submitted` may become `met`. `pending` means the
 * client has not paid for the stage before it — the unlock handler moves it
 * to `in_progress` when they do — and marking locked work met would claim
 * delivery ahead of the money that gates it. `met` is idempotent-by-refusal:
 * the answer names the moment it was already met. `rejected` stays rejected.
 *
 * One conditional UPDATE, predicated on the status the read saw, so two
 * people marking the same milestone at once cannot both be told they did.
 */
export async function markMilestoneMet(
  input: MarkMilestoneMetInput,
): Promise<Result<{ milestoneId: string; metAt: string }>> {
  const parsed = markMilestoneMetSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid milestone.');

  const context = await requireInternal();
  if (!can(context, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to mark a milestone met.');
  }

  const supabase = await createClient();
  const { data: milestone, error: readError } = await supabase
    .schema('projects')
    .from('milestones')
    .select('id, name, status, met_at')
    .eq('id', parsed.data.milestoneId)
    .maybeSingle();
  if (readError) {
    console.error(JSON.stringify({ level: 'error', scope: 'markMilestoneMet.read', detail: readError.message }));
    return err('INTERNAL', 'Could not read the milestone.');
  }
  if (!milestone) return err('NOT_FOUND', 'Milestone not found.');

  if (milestone.status === 'met') {
    return err('CONFLICT', `"${milestone.name}" was already marked met${milestone.met_at ? ` on ${milestone.met_at.slice(0, 10)}` : ''}.`);
  }
  if (milestone.status === 'rejected') {
    return err('CONFLICT', `"${milestone.name}" was rejected and cannot be marked met.`);
  }
  if (!(MEETABLE_MILESTONE_STATUSES as readonly string[]).includes(milestone.status)) {
    return err(
      'CONFLICT',
      `"${milestone.name}" is still pending — it unlocks when the stage before it is paid, and cannot be marked met before then.`,
    );
  }

  const metAt = new Date().toISOString();
  const { data: updated, error } = await supabase
    .schema('projects')
    .from('milestones')
    .update({ status: 'met', met_at: metAt })
    .eq('id', milestone.id)
    .eq('status', milestone.status)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'markMilestoneMet', detail: error.message }));
    return err('INTERNAL', 'Could not mark the milestone met.');
  }
  if (!updated) return err('CONFLICT', 'The milestone changed while you were looking at it. Reload and try again.');

  return ok({ milestoneId: updated.id, metAt });
}
