import { z } from 'zod';

import { LAYER_STATUSES, PLAN_LAYERS } from './plan-layers-types';

/** SCR-040 — the form that sets a deliverable's seven layers and its execution order. */

export const setPlanLayersSchema = z.object({
  projectId: z.uuid(),
  planDeliverableId: z.uuid(),
  layers: z.record(
    z.enum(PLAN_LAYERS),
    z.object({ status: z.enum(LAYER_STATUSES), note: z.string().trim().max(500).nullable().default(null) }),
  ),
  executionOrder: z.coerce.number().int().min(1).max(999).optional(),
});
export type SetPlanLayersInput = z.input<typeof setPlanLayersSchema>;
