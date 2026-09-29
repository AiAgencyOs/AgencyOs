import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  setRollbackPlanSchema,
  setSmokeItemSchema,
  type SetRollbackPlanInput,
  type SetSmokeItemInput,
} from './handover-release-schema';

/**
 * SCR-049's two doors — `projects.set_handover_rollback_plan` and
 * `projects.set_handover_smoke_item`. `project.write`: the same roles
 * `handovers_write` admits (`core.can_manage_delivery()`), and the database
 * asks again. Both audited inside the function.
 */

function refused(outcome: string | undefined, verb: string): Result<never> {
  switch (outcome) {
    case 'not_found':
      return err('NOT_FOUND', 'Handover not found.');
    case 'bad_label':
      return err('VALIDATION', 'A smoke check needs a name of at most 200 characters.');
    default:
      return err('FORBIDDEN', `You do not have permission to ${verb}.`);
  }
}

export async function setHandoverRollbackPlan(input: SetRollbackPlanInput): Promise<Result<{ cleared: boolean }>> {
  const parsed = setRollbackPlanSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid rollback plan.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to set the rollback plan.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_handover_rollback_plan', {
    p_handover_id: parsed.data.handoverId,
    p_rollback_plan: parsed.data.rollbackPlan,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setHandoverRollbackPlan', detail: error.message }));
    return err('INTERNAL', 'Could not set the rollback plan.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'set') return ok({ cleared: parsed.data.rollbackPlan.length === 0 });
  return refused(row?.outcome, 'set the rollback plan');
}

export async function setHandoverSmokeItem(input: SetSmokeItemInput): Promise<Result<{ removed: boolean }>> {
  const parsed = setSmokeItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid smoke check.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit the smoke checklist.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_handover_smoke_item', {
    p_handover_id: parsed.data.handoverId,
    p_label: parsed.data.label,
    p_done: parsed.data.done,
    p_remove: parsed.data.remove,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setHandoverSmokeItem', detail: error.message }));
    return err('INTERNAL', 'Could not update the smoke checklist.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'set') return ok({ removed: false });
  if (row?.outcome === 'removed') return ok({ removed: true });
  return refused(row?.outcome, 'edit the smoke checklist');
}
