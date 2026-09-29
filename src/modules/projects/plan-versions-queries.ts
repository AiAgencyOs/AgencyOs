import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Every version of a project's plan — SCR-040's versions list.
 *
 * `readPlanBoard` reads the newest plan only, which is right for a working
 * surface. Project Planning §4.8 forbids rewriting history precisely so a
 * person can later read what v1 said and why v2 replaced it
 * (`change_reason`); until now nothing read the superseded rows back.
 */
export type PlanVersion = {
  id: string;
  version: number;
  status: string;
  objective: string | null;
  changeReason: string | null;
  scopeVersion: number | null;
  createdAt: string;
  activatedAt: string | null;
  deliverables: number;
};

export async function listPlanVersions(projectId: string): Promise<PlanVersion[]> {
  const supabase = await createClient();

  const { data: plans, error: plansError } = await supabase
    .schema('projects')
    .from('project_plans')
    .select('id, version, status, objective, change_reason, scope_version_id, created_at, activated_at')
    .eq('project_id', projectId)
    .order('version', { ascending: false });
  if (plansError) unreadable('listPlanVersions.plans', plansError);

  const rows = plans ?? [];
  if (rows.length === 0) return [];

  const scopeIds = [...new Set(rows.map((p) => p.scope_version_id).filter((id): id is string => id !== null))];
  const [scopeVersions, deliverables] = await Promise.all([
    scopeIds.length > 0
      ? supabase.schema('projects').from('scope_versions').select('id, version').in('id', scopeIds)
      : Promise.resolve({ data: [] as { id: string; version: number }[], error: null }),
    supabase
      .schema('projects')
      .from('plan_deliverables')
      .select('plan_id')
      .in(
        'plan_id',
        rows.map((p) => p.id),
      ),
  ]);
  if (scopeVersions.error) unreadable('listPlanVersions.scopeVersions', scopeVersions.error);
  if (deliverables.error) unreadable('listPlanVersions.deliverables', deliverables.error);

  const scopeNumber = new Map((scopeVersions.data ?? []).map((v) => [v.id, v.version]));
  const deliverableCount = new Map<string, number>();
  for (const d of deliverables.data ?? []) deliverableCount.set(d.plan_id, (deliverableCount.get(d.plan_id) ?? 0) + 1);

  return rows.map((p) => ({
    id: p.id,
    version: p.version,
    status: p.status,
    objective: p.objective,
    changeReason: p.change_reason,
    scopeVersion: p.scope_version_id ? (scopeNumber.get(p.scope_version_id) ?? null) : null,
    createdAt: p.created_at,
    activatedAt: p.activated_at,
    deliverables: deliverableCount.get(p.id) ?? 0,
  }));
}
