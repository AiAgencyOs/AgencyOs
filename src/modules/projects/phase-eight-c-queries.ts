import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What staff see of the maintenance plan lifecycle and the post-launch sweeps for one project, from the STORED state. Every read is guarded: a failed
 * read is `unreadable`, never rendered as "nothing here". The gate state, entitlement, usage and overage are the database's own (computed, never stored).
 */

type Row = Record<string, unknown>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): Res & { order(column: string, options: { ascending: boolean }): Res & { limit(n: number): Res }; limit(n: number): Res };
      in(column: string, values: string[]): Res & { limit(n: number): Res };
      order(column: string, options: { ascending: boolean }): Res & { limit(n: number): Res };
    };
  };
  rpc(fn: string, args: Record<string, unknown>): Res;
};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export type PlanLifecycleView = {
  planId: string;
  name: string;
  version: number;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  accepted: boolean;
  gateState: string | null;
  gateDetail: string | null;
  cycle: { id: string; startsOn: string; endsOn: string } | null;
  entitledHours: number | null;
  usedHours: number | null;
  overageHours: number | null;
  entitledRequests: number | null;
  usedRequests: number | null;
  overageRequests: number | null;
  openRenewalStatus: string | null;
  openCancellationId: string | null;
  renewalId: string | null;
  usage: { id: string; kind: string; type: string; quantity: number; occurredOn: string }[];
  drafts: { kind: string; overage: number; unitRateMinor: number | null; amountMinor: number | null; currency: string | null }[];
};
export type CatalogView = { id: string; name: string; version: number; status: string; billingModel: string; includedHours: number | null; includedRequests: number | null; createdByViewer: boolean; priceLines: { label: string; per: string; amountMinor: number; currency: string }[] };
export type BreachView = { id: string; workItemId: string; priority: string; dueAt: string; acknowledged: boolean };
export type StallView = { workItemId: string; reason: string; detail: string; detectedAt: string };
export type SafetyView = { workItemId: string; title: string; commitRef: string | null; recorded: boolean };
export type PhaseEightCView = {
  plans: PlanLifecycleView[];
  catalog: CatalogView[];
  churn: { reason: string; plans: number }[];
  breaches: BreachView[];
  stalls: StallView[];
  safety: SafetyView[];
  stallPolicyHours: number | null;
  acceptedProposals: { id: string; title: string }[];
  usageTargets: { value: string; label: string }[];
};

export async function readPhaseEightCView(projectId: string): Promise<PhaseEightCView> {
  const context = await requireInternal();
  const supabase = await createClient();
  const projects = supabase.schema('projects') as unknown as Loose;
  const sales = supabase.schema('sales') as unknown as Loose;

  const [overview, catalog, prices, breaches, acks, stalls, stallPolicy, items, tickets, churn, proposals] = await Promise.all([
    projects.rpc('maintenance_plan_overview', { p_project_id: projectId }),
    projects.from('maintenance_plan_catalog').select('id, name, version, status, billing_model, included_hours, included_requests, created_by').order('created_at', { ascending: false }).limit(40),
    projects.from('maintenance_plan_price_lines').select('catalog_id, label, per, amount_minor, currency').order('entered_at', { ascending: true }).limit(400),
    projects.from('maintenance_sla_breaches').select('id, work_item_id, priority, resolution_due_at').eq('project_id', projectId).order('detected_at', { ascending: false }).limit(50),
    projects.from('maintenance_sla_breach_acknowledgements').select('breach_id').order('acknowledged_at', { ascending: false }).limit(400),
    projects.from('maintenance_work_stalls').select('work_item_id, reason_code, detail, detected_at').order('detected_at', { ascending: false }).limit(100),
    projects.from('maintenance_stall_policies').select('stalled_after_hours').order('version', { ascending: false }).limit(1),
    projects.from('maintenance_work_items').select('id, title, status, area, sensitive, commit_ref').eq('project_id', projectId).order('created_at', { ascending: false }).limit(60),
    projects.from('maintenance_items').select('id, title, coverage').eq('project_id', projectId).order('created_at', { ascending: false }).limit(60),
    projects.rpc('maintenance_churn_summary', {}),
    sales.from('proposals').select('id, title, status').order('created_at', { ascending: false }).limit(60),
  ]);
  if (overview.error) unreadable('readPhaseEightCView.overview', overview.error);
  if (catalog.error) unreadable('readPhaseEightCView.catalog', catalog.error);
  if (prices.error) unreadable('readPhaseEightCView.prices', prices.error);
  if (breaches.error) unreadable('readPhaseEightCView.breaches', breaches.error);
  if (acks.error) unreadable('readPhaseEightCView.acks', acks.error);
  if (stalls.error) unreadable('readPhaseEightCView.stalls', stalls.error);
  if (stallPolicy.error) unreadable('readPhaseEightCView.stallPolicy', stallPolicy.error);
  if (items.error) unreadable('readPhaseEightCView.items', items.error);
  if (tickets.error) unreadable('readPhaseEightCView.tickets', tickets.error);
  if (churn.error) unreadable('readPhaseEightCView.churn', churn.error);
  if (proposals.error) unreadable('readPhaseEightCView.proposals', proposals.error);

  const planRows = rows(overview.data);
  const planIds = planRows.map((p) => String(p.plan_id));
  const [entries, drafts, renewals] = await Promise.all([
    planIds.length ? projects.from('maintenance_usage_entries').select('id, plan_id, entry_kind, entry_type, quantity, occurred_on').in('plan_id', planIds).limit(300) : Promise.resolve({ data: [], error: null }),
    planIds.length ? projects.from('maintenance_overage_drafts').select('plan_id, entry_kind, overage_quantity, unit_rate_minor, amount_minor, currency').in('plan_id', planIds).limit(100) : Promise.resolve({ data: [], error: null }),
    planIds.length ? projects.from('maintenance_plan_renewals').select('id, plan_id, status').in('plan_id', planIds).limit(100) : Promise.resolve({ data: [], error: null }),
  ]);
  if (entries.error) unreadable('readPhaseEightCView.entries', entries.error);
  if (drafts.error) unreadable('readPhaseEightCView.drafts', drafts.error);
  if (renewals.error) unreadable('readPhaseEightCView.renewals', renewals.error);

  const acked = new Set(rows(acks.data).map((a) => String(a.breach_id)));
  const priceBy = new Map<string, CatalogView['priceLines']>();
  for (const p of rows(prices.data)) {
    const list = priceBy.get(String(p.catalog_id)) ?? [];
    list.push({ label: String(p.label), per: String(p.per), amountMinor: Number(p.amount_minor), currency: String(p.currency) });
    priceBy.set(String(p.catalog_id), list);
  }

  // data safety: the sensitive database changes of this project and whether their CURRENT commit has a record (the database's own gate decides; this only lists)
  const sensitive = rows(items.data).filter((i) => i.sensitive === true && i.area === 'database' && !['released', 'cancelled'].includes(String(i.status)));
  const safety: SafetyView[] = [];
  for (const i of sensitive) {
    const gate = await projects.rpc('evaluate_maintenance_gates', { p_work_item_id: String(i.id) });
    if (gate.error) unreadable('readPhaseEightCView.dataSafetyGate', gate.error);
    const g = rows(gate.data).find((r) => r.gate === 'data_safety');
    safety.push({ workItemId: String(i.id), title: String(i.title), commitRef: str(i.commit_ref), recorded: g?.passed === true });
  }
  const itemIds = new Set(rows(items.data).map((i) => String(i.id)));

  return {
    plans: planRows.map((p) => {
      const id = String(p.plan_id);
      const renewal = rows(renewals.data).find((r) => r.plan_id === id && ['proposed', 'accepted'].includes(String(r.status)));
      return {
        planId: id, name: String(p.name), version: Number(p.version), status: String(p.status), startsOn: str(p.starts_on), endsOn: str(p.ends_on), accepted: p.accepted === true,
        gateState: str(p.gate_state), gateDetail: str(p.gate_detail), cycle: str(p.cycle_id) ? { id: String(p.cycle_id), startsOn: String(p.cycle_starts_on), endsOn: String(p.cycle_ends_on) } : null,
        entitledHours: numOrNull(p.entitled_hours), usedHours: numOrNull(p.used_hours), overageHours: numOrNull(p.overage_hours),
        entitledRequests: numOrNull(p.entitled_requests), usedRequests: numOrNull(p.used_requests), overageRequests: numOrNull(p.overage_requests),
        openRenewalStatus: str(p.open_renewal_status), openCancellationId: str(p.open_cancellation_id), renewalId: renewal ? String(renewal.id) : null,
        usage: rows(entries.data).filter((e) => e.plan_id === id).sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on))).slice(0, 12)
          .map((e) => ({ id: String(e.id), kind: String(e.entry_kind), type: String(e.entry_type), quantity: Number(e.quantity), occurredOn: String(e.occurred_on) })),
        drafts: rows(drafts.data).filter((d) => d.plan_id === id).map((d) => ({ kind: String(d.entry_kind), overage: Number(d.overage_quantity), unitRateMinor: numOrNull(d.unit_rate_minor), amountMinor: numOrNull(d.amount_minor), currency: str(d.currency) })),
      };
    }),
    catalog: rows(catalog.data).map((c) => ({
      id: String(c.id), name: String(c.name), version: Number(c.version), status: String(c.status), billingModel: String(c.billing_model), includedHours: numOrNull(c.included_hours), includedRequests: numOrNull(c.included_requests),
      createdByViewer: c.created_by === context.userId, priceLines: priceBy.get(String(c.id)) ?? [],
    })),
    churn: rows(churn.data).map((c) => ({ reason: String(c.reason_code), plans: Number(c.plans) })),
    breaches: rows(breaches.data).map((b) => ({ id: String(b.id), workItemId: String(b.work_item_id), priority: String(b.priority), dueAt: String(b.resolution_due_at), acknowledged: acked.has(String(b.id)) })),
    stalls: rows(stalls.data).filter((s) => itemIds.has(String(s.work_item_id))).map((s) => ({ workItemId: String(s.work_item_id), reason: String(s.reason_code), detail: String(s.detail), detectedAt: String(s.detected_at) })),
    safety,
    stallPolicyHours: numOrNull(rows(stallPolicy.data)[0]?.stalled_after_hours),
    acceptedProposals: rows(proposals.data).filter((p) => p.status === 'accepted').map((p) => ({ id: String(p.id), title: String(p.title) })),
    usageTargets: [
      ...rows(items.data).map((i) => ({ value: `work:${String(i.id)}`, label: `Work: ${String(i.title)}` })),
      ...rows(tickets.data).filter((t) => t.coverage !== 'warranty').map((t) => ({ value: `ticket:${String(t.id)}`, label: `Ticket: ${String(t.title)}` })),
    ],
  };
}
