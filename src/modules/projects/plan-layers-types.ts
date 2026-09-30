/**
 * SCR-040 — the seven implementation layers of a plan deliverable and their
 * execution order (migration 20261001130000). Client-safe: no server import.
 */

export const PLAN_LAYERS = ['frontend', 'backend', 'database', 'apis', 'integrations', 'auth', 'business_logic'] as const;
export type PlanLayer = (typeof PLAN_LAYERS)[number];

export const PLAN_LAYER_LABEL: Record<PlanLayer, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  database: 'Database',
  apis: 'APIs',
  integrations: 'Integrations',
  auth: 'Auth',
  business_logic: 'Business logic',
};

export const LAYER_STATUSES = ['planned', 'in_progress', 'done', 'not_applicable'] as const;
export type LayerStatus = (typeof LAYER_STATUSES)[number];

export type LayerEntry = { status: LayerStatus; note: string | null };

export type PlanLayersRecord = {
  planDeliverableId: string;
  layers: Partial<Record<PlanLayer, LayerEntry>>;
  executionOrder: number | null;
  updatedAt: string | null;
};
