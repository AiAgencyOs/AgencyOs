import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { addUnpricedMilestoneSchema, type AddUnpricedMilestoneInput } from './milestone-create-schema';

/**
 * SCR-022 — add an unpriced milestone on a day. `milestone.write`, and
 * `projects.add_unpriced_milestone` checks `core.can_manage_delivery()`
 * again, takes the next position and audits `milestone.added_unpriced`.
 */
export async function addUnpricedMilestone(input: AddUnpricedMilestoneInput): Promise<Result<{ milestoneId: string }>> {
  const parsed = addUnpricedMilestoneSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid milestone.');

  const context = await requireInternal();
  if (!can(context, 'milestone.write')) return err('FORBIDDEN', 'You do not have permission to add milestones.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_unpriced_milestone', {
    p_project_id: parsed.data.projectId,
    p_name: parsed.data.name,
    ...(parsed.data.dueOn ? { p_due_on: parsed.data.dueOn } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addUnpricedMilestone', detail: error.message }));
    return err('INTERNAL', 'Could not add the milestone.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; milestone_id?: string | null } | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'added':
      return ok({ milestoneId: row?.milestone_id ?? '' });
    case 'no_name':
      return err('VALIDATION', 'A milestone needs a name.');
    case 'not_found':
      return err('NOT_FOUND', 'That project is not visible to you.');
    default:
      return err('FORBIDDEN', 'You do not have permission to add a milestone to this project.');
  }
}
