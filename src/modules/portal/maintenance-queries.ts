import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The client's own maintenance plan, usage and what is beyond what is included. The database functions decide what a client may see (their own account
 * only; plain facts; no internal reason, price, draft, exception, work item or note); nothing here widens it. A failed read is `unreadable`, never "no plan".
 */
export type ClientMaintenancePlan = {
  planId: string;
  name: string;
  statusLabel: string;
  billingModel: string;
  startsOn: string | null;
  endsOn: string | null;
  cycleStartsOn: string | null;
  cycleEndsOn: string | null;
  entitledHours: number | null;
  usedHours: number | null;
  entitledRequests: number | null;
  usedRequests: number | null;
  hoursBeyondIncluded: number | null;
  requestsBeyondIncluded: number | null;
  usage: { occurredOn: string; kind: string; type: string; quantity: number }[];
};

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export async function readClientMaintenance(projectId: string): Promise<ClientMaintenancePlan[]> {
  const supabase = await createClient();
  const projects = supabase.schema('projects');
  const plans = await projects.rpc('client_maintenance_plans' as never, { p_project_id: projectId } as never);
  if (plans.error) unreadable('readClientMaintenance.plans', plans.error);
  const list = (plans.data ?? []) as unknown as Record<string, unknown>[];
  const out: ClientMaintenancePlan[] = [];
  for (const p of list) {
    const usage = await projects.rpc('client_maintenance_usage' as never, { p_plan_id: String(p.plan_id) } as never);
    if (usage.error) unreadable('readClientMaintenance.usage', usage.error);
    out.push({
      planId: String(p.plan_id), name: String(p.plan_name), statusLabel: String(p.status_label), billingModel: String(p.billing_model), startsOn: s(p.starts_on), endsOn: s(p.ends_on),
      cycleStartsOn: s(p.cycle_starts_on), cycleEndsOn: s(p.cycle_ends_on), entitledHours: n(p.entitled_hours), usedHours: n(p.used_hours), entitledRequests: n(p.entitled_requests),
      usedRequests: n(p.used_requests), hoursBeyondIncluded: n(p.hours_beyond_included), requestsBeyondIncluded: n(p.requests_beyond_included),
      usage: ((usage.data ?? []) as unknown as Record<string, unknown>[]).map((u) => ({ occurredOn: String(u.occurred_on), kind: String(u.entry_kind), type: String(u.entry_type), quantity: Number(u.quantity) })),
    });
  }
  return out;
}
