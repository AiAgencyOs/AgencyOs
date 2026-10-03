'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setPlanLayers } from './plan-layers-service';
import { LAYER_STATUSES, PLAN_LAYERS, type LayerStatus } from './plan-layers-types';

/** SCR-040 — the plan page's per-deliverable layers form. Fields: `layer.<name>.status`, `layer.<name>.note`, `executionOrder`. */
export async function setPlanLayersAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const layers: Record<string, { status: LayerStatus; note: string | null }> = {};
  for (const layer of PLAN_LAYERS) {
    const status = String(formData.get(`layer.${layer}.status`) ?? '');
    if (!(LAYER_STATUSES as readonly string[]).includes(status)) continue;
    layers[layer] = { status: status as LayerStatus, note: String(formData.get(`layer.${layer}.note`) ?? '').trim() || null };
  }
  const order = String(formData.get('executionOrder') ?? '').trim();
  const result = await setPlanLayers({
    projectId,
    planDeliverableId: String(formData.get('planDeliverableId') ?? ''),
    layers,
    executionOrder: order ? order : undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/plan`);
  revalidatePath(`/projects/${projectId}/development`);
  return { status: 'success', message: 'Layers and order saved.' };
}
