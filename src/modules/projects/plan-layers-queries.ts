import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { PLAN_LAYERS, type LayerEntry, type PlanLayer, type PlanLayersRecord } from './plan-layers-types';

/** SCR-040 — the layers and execution order recorded for the deliverables of a plan. */
export async function listPlanLayers(planDeliverableIds: readonly string[]): Promise<Map<string, PlanLayersRecord>> {
  if (planDeliverableIds.length === 0) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('plan_layers')
    .select('plan_deliverable_id, layers, execution_order, updated_at')
    .in('plan_deliverable_id', [...planDeliverableIds]);
  if (error) unreadable('listPlanLayers', error);

  const out = new Map<string, PlanLayersRecord>();
  for (const row of (data ?? []) as { plan_deliverable_id: string; layers: unknown; execution_order: number | null; updated_at: string }[]) {
    const raw = (row.layers && typeof row.layers === 'object' ? row.layers : {}) as Record<string, { status?: string; note?: string | null }>;
    const layers: Partial<Record<PlanLayer, LayerEntry>> = {};
    for (const layer of PLAN_LAYERS) {
      const entry = raw[layer];
      if (entry && typeof entry.status === 'string') {
        layers[layer] = { status: entry.status as LayerEntry['status'], note: entry.note ?? null };
      }
    }
    out.set(row.plan_deliverable_id, { planDeliverableId: row.plan_deliverable_id, layers, executionOrder: row.execution_order, updatedAt: row.updated_at });
  }
  return out;
}
