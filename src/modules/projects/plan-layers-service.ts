import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setPlanLayersSchema, type SetPlanLayersInput } from './plan-layers-schema';

/**
 * SCR-040 — the one door onto `projects.plan_layers` (migration
 * 20261001130000). `milestone.write`, the capability the plan's own
 * breakdown door takes; `core.can_manage_delivery()` again inside. Allowed
 * on an ACTIVE plan on purpose: the layers are Phase 5's work on the plan
 * that went live, which is why they live beside plan_deliverables rather
 * than in it.
 */
export async function setPlanLayers(input: SetPlanLayersInput): Promise<Result<{ id: string }>> {
  const parsed = setPlanLayersSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid layers.');

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) return err('FORBIDDEN', 'You do not have permission to change the plan breakdown.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_plan_layers', {
    p_plan_deliverable_id: parsed.data.planDeliverableId,
    p_layers: parsed.data.layers,
    p_execution_order: parsed.data.executionOrder,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setPlanLayers', detail: error.message }));
    return err('INTERNAL', 'Could not save the layers.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ id: row.id ?? '' });
    case 'not_found':
      return err('NOT_FOUND', 'Deliverable not found.');
    case 'bad_layers':
      return err('VALIDATION', 'Only the seven layers, each planned, in progress, done or not applicable.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may set the layers.');
    default:
      return err('INTERNAL', 'Could not save the layers.');
  }
}
