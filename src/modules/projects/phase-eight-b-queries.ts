import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';
import {
  decideMaintenanceRoute,
  rankMaintenanceQueue,
  classifyMaintenancePriority,
  slaStateFor,
  type MaintenanceArea,
  type MaintenanceKind,
  type MaintenancePriority,
  type SlaPolicy,
  type SlaState,
} from '@/modules/orchestrator/maintenance-route';

/**
 * What staff see of post-launch maintenance work for one project, from the STORED state. Every read is guarded (G-054): a failed read is `unreadable`,
 * never rendered as "nothing here". The gates are the database's own (`projects.evaluate_maintenance_gates`); nothing here computes a pass.
 * The SLA state is derived from an Admin-set policy; with none it is shown as unknown.
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
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

export type GateRow = { gate: string; passed: boolean; detail: string };
export type WorkItemView = {
  id: string;
  kind: MaintenanceKind;
  area: MaintenanceArea;
  title: string;
  status: string;
  emergency: boolean;
  sensitive: boolean;
  commitRef: string | null;
  fixSummary: string | null;
  rollbackPlan: string | null;
  defectId: string | null;
  changeRequestId: string | null;
  ticketId: string | null;
  priority: MaintenancePriority;
  sla: SlaState;
  raisedAt: string;
  gates: GateRow[];
  qaResults: { category: string; status: string; commit: string; evidence: string | null; reason: string | null; at: string }[];
  routing: { outcome: string; toAgent: string | null; reason: string; candidates: { agent: string; eligible: boolean; rejected: string | null }[]; independentQa: string[]; at: string } | null;
  /** The viewer built or requested this: the database will refuse their approval. */
  viewerIsAuthor: boolean;
  /** The Orchestrator's CURRENT recommendation, computed now from the same facts (not yet recorded). */
  recommendation: { outcome: string; reason: string; toAgent: string | null } | null;
  proposals: { id: string; agent: string; kind: string; summary: string; steps: string[]; risks: string[]; needsScopeChange: boolean; recommendsSecurityReview: boolean; viewerAsked: boolean; decision: { decision: string; note: string | null } | null }[];
};
export type BillingProposalView = {
  id: string;
  kind: string;
  currency: string | null;
  totalMinor: number | null;
  balanceMinor: number | null;
  lines: { description: string; quantity: number }[];
  narrative: string | null;
  reminderText: string | null;
  viewerAsked: boolean;
  decision: { decision: string; note: string | null } | null;
};
export type PlanGateView = { planId: string; name: string; status: string; gateState: string; gateDetail: string };
export type PhaseEightBView = {
  items: WorkItemView[];
  slaPolicies: { priority: string; version: number; responseHours: number; resolutionHours: number; atRiskPercent: number | null }[];
  billing: BillingProposalView[];
  plans: PlanGateView[];
  /** What a person may open the next piece of work against. */
  openable: { tickets: { id: string; title: string }[]; defects: { id: string; title: string }[]; changeRequests: { id: string; title: string }[]; plans: { id: string; name: string }[]; invoices: { id: string; number: string }[] };
};

export async function readPhaseEightBView(projectId: string): Promise<PhaseEightBView> {
  const context = await requireInternal();
  const supabase = await createClient();
  const projects = supabase.schema('projects') as unknown as Loose;
  const finance = supabase.schema('finance') as unknown as Loose;
  const qa = supabase.schema('qa') as unknown as Loose;
  const now = new Date();

  const [items, policies, tickets, defects, crs, plans, invoices, finProposals] = await Promise.all([
    projects.from('maintenance_work_items').select('id, kind, area, title, status, emergency, sensitive, commit_ref, fix_summary, rollback_plan, defect_id, change_request_id, ticket_id, created_by, commit_submitted_by, release_requested_by, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    projects.from('maintenance_sla_policies').select('priority, version, response_hours, resolution_hours, at_risk_percent').order('version', { ascending: false }).limit(40),
    projects.from('maintenance_items').select('id, title, coverage, status').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    qa.from('defects').select('id, title, status, classification, s_level').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    projects.from('change_requests').select('id, requested, status, classification').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    projects.from('maintenance_plans').select('id, name, status').eq('project_id', projectId).order('created_at', { ascending: false }).limit(20),
    finance.from('invoices').select('id, number, status').eq('project_id', projectId).order('created_at', { ascending: false }).limit(30),
    finance.from('maintenance_billing_proposals').select('id, kind, currency, total_minor, balance_minor, lines, narrative, reminder_text, requested_by').eq('project_id', projectId).order('created_at', { ascending: false }).limit(30),
  ]);
  if (items.error) unreadable('readPhaseEightBView.items', items.error);
  if (policies.error) unreadable('readPhaseEightBView.policies', policies.error);
  if (tickets.error) unreadable('readPhaseEightBView.tickets', tickets.error);
  if (defects.error) unreadable('readPhaseEightBView.defects', defects.error);
  if (crs.error) unreadable('readPhaseEightBView.changeRequests', crs.error);
  if (plans.error) unreadable('readPhaseEightBView.plans', plans.error);
  if (invoices.error) unreadable('readPhaseEightBView.invoices', invoices.error);
  if (finProposals.error) unreadable('readPhaseEightBView.billingProposals', finProposals.error);

  // newest version per priority wins; the older ones stay on the record
  const policyBy = new Map<MaintenancePriority, SlaPolicy>();
  const policyRows = rows(policies.data);
  for (const p of policyRows) {
    const k = String(p.priority) as MaintenancePriority;
    if (!policyBy.has(k)) policyBy.set(k, { version: Number(p.version), responseHours: Number(p.response_hours), resolutionHours: Number(p.resolution_hours), atRiskPercent: p.at_risk_percent === null ? null : Number(p.at_risk_percent) });
  }

  const itemRows = rows(items.data);
  const ids = itemRows.map((i) => String(i.id));
  const defectRows = rows(defects.data);
  const sBy = new Map(defectRows.map((d) => [String(d.id), d.s_level === null ? null : Number(d.s_level)] as const));

  const [qaResults, routing, proposals] = ids.length
    ? await Promise.all([
        projects.from('maintenance_qa_results').select('work_item_id, category, status, commit_ref, evidence_ref, reason, recorded_at').in('work_item_id', ids).limit(300),
        projects.from('maintenance_routing_decisions').select('work_item_id, outcome, to_agent, reason, candidates, independent_qa, decided_at').in('work_item_id', ids).limit(300),
        projects.from('maintenance_agent_proposals').select('id, work_item_id, agent_key, kind, summary, steps, risks, needs_scope_change, recommends_security_review, requested_by').in('work_item_id', ids).limit(200),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  if (qaResults.error) unreadable('readPhaseEightBView.qaResults', qaResults.error);
  if (routing.error) unreadable('readPhaseEightBView.routing', routing.error);
  if (proposals.error) unreadable('readPhaseEightBView.proposals', proposals.error);
  const proposalRows = rows(proposals.data);
  const proposalIds = proposalRows.map((p) => String(p.id));
  const finIds = rows(finProposals.data).map((p) => String(p.id));
  const [proposalDecisions, finDecisions] = await Promise.all([
    proposalIds.length ? projects.from('maintenance_agent_proposal_decisions').select('proposal_id, decision, note').in('proposal_id', proposalIds).limit(200) : Promise.resolve({ data: [], error: null }),
    finIds.length ? finance.from('maintenance_billing_decisions').select('proposal_id, decision, note').in('proposal_id', finIds).limit(200) : Promise.resolve({ data: [], error: null }),
  ]);
  if (proposalDecisions.error) unreadable('readPhaseEightBView.proposalDecisions', proposalDecisions.error);
  if (finDecisions.error) unreadable('readPhaseEightBView.billingDecisions', finDecisions.error);
  const pdBy = new Map(rows(proposalDecisions.data).map((d) => [String(d.proposal_id), d] as const));
  const fdBy = new Map(rows(finDecisions.data).map((d) => [String(d.proposal_id), d] as const));

  const views: WorkItemView[] = [];
  for (const i of itemRows) {
    const id = String(i.id);
    const gateRes = await projects.rpc('evaluate_maintenance_gates', { p_work_item_id: id });
    if (gateRes.error) unreadable('readPhaseEightBView.gates', gateRes.error);
    const gates = rows(gateRes.data).map((g) => ({ gate: String(g.gate), passed: g.passed === true, detail: String(g.detail ?? '') }));
    const defectId = str(i.defect_id);
    const sLevel = defectId ? (sBy.get(defectId) ?? null) : null;
    const priority = classifyMaintenancePriority({ kind: String(i.kind) as MaintenanceKind, emergency: i.emergency === true, sensitive: i.sensitive === true, defectSLevel: sLevel });
    const sla = slaStateFor({ priority, raisedAt: String(i.created_at), now, policy: policyBy.get(priority) });
    const route = rows(routing.data).filter((r) => r.work_item_id === id).sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)))[0];
    // the recommendation is computed now, with every specialist treated as installed-but-unproven: the person sees what the Orchestrator would do
    const rec = decideMaintenanceRoute({
      item: { id, kind: String(i.kind) as MaintenanceKind, area: String(i.area) as MaintenanceArea, status: String(i.status), emergency: i.emergency === true, sensitive: i.sensitive === true, commitRef: str(i.commit_ref), hasDefect: defectId !== null, defectSLevel: sLevel, raisedAt: String(i.created_at) },
      enabled: new Map(), failingGates: gates.filter((g) => !g.passed).map((g) => g.gate), policies: policyBy, now,
    });
    views.push({
      id, kind: String(i.kind) as MaintenanceKind, area: String(i.area) as MaintenanceArea, title: String(i.title), status: String(i.status), emergency: i.emergency === true, sensitive: i.sensitive === true,
      commitRef: str(i.commit_ref), fixSummary: str(i.fix_summary), rollbackPlan: str(i.rollback_plan), defectId, changeRequestId: str(i.change_request_id), ticketId: str(i.ticket_id), priority, sla, raisedAt: String(i.created_at), gates,
      qaResults: rows(qaResults.data).filter((r) => r.work_item_id === id).sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at))).map((r) => ({ category: String(r.category), status: String(r.status), commit: String(r.commit_ref), evidence: str(r.evidence_ref), reason: str(r.reason), at: String(r.recorded_at) })),
      routing: route ? { outcome: String(route.outcome), toAgent: str(route.to_agent), reason: String(route.reason), candidates: Array.isArray(route.candidates) ? (route.candidates as { agent: string; eligible: boolean; rejected: string | null }[]) : [], independentQa: Array.isArray(route.independent_qa) ? route.independent_qa.map(String) : [], at: String(route.decided_at) } : null,
      viewerIsAuthor: [i.created_by, i.commit_submitted_by, i.release_requested_by].includes(context.userId),
      recommendation: { outcome: rec.outcome, reason: rec.reason, toAgent: rec.toAgent },
      proposals: proposalRows.filter((p) => p.work_item_id === id).map((p) => {
        const d = pdBy.get(String(p.id));
        return { id: String(p.id), agent: String(p.agent_key), kind: String(p.kind), summary: String(p.summary), steps: Array.isArray(p.steps) ? p.steps.map(String) : [], risks: Array.isArray(p.risks) ? p.risks.map(String) : [], needsScopeChange: p.needs_scope_change === true, recommendsSecurityReview: p.recommends_security_review === true, viewerAsked: p.requested_by === context.userId, decision: d ? { decision: String(d.decision), note: str(d.note) } : null };
      }),
    });
  }
  const ranked = rankMaintenanceQueue(views.map((v) => ({ ...v })));

  const planRows = rows(plans.data);
  const planViews: PlanGateView[] = [];
  for (const p of planRows) {
    const g = await finance.rpc('maintenance_financial_gate', { p_plan_id: String(p.id) });
    if (g.error) unreadable('readPhaseEightBView.planGate', g.error);
    const row = rows(g.data)[0];
    planViews.push({ planId: String(p.id), name: String(p.name), status: String(p.status), gateState: String(row?.state ?? 'not_billed'), gateDetail: String(row?.detail ?? '') });
  }

  return {
    items: ranked,
    slaPolicies: policyRows.map((p) => ({ priority: String(p.priority), version: Number(p.version), responseHours: Number(p.response_hours), resolutionHours: Number(p.resolution_hours), atRiskPercent: p.at_risk_percent === null ? null : Number(p.at_risk_percent) })),
    billing: rows(finProposals.data).map((p) => {
      const d = fdBy.get(String(p.id));
      return {
        id: String(p.id), kind: String(p.kind), currency: str(p.currency), totalMinor: p.total_minor === null ? null : Number(p.total_minor), balanceMinor: p.balance_minor === null ? null : Number(p.balance_minor),
        lines: Array.isArray(p.lines) ? (p.lines as Row[]).map((l) => ({ description: String(l.description), quantity: Number(l.quantity) })) : [], narrative: str(p.narrative), reminderText: str(p.reminder_text),
        viewerAsked: p.requested_by === context.userId, decision: d ? { decision: String(d.decision), note: str(d.note) } : null,
      };
    }),
    plans: planViews,
    openable: {
      tickets: rows(tickets.data).filter((t) => (t.coverage === 'warranty' || t.coverage === 'maintenance') && t.status !== 'resolved' && t.status !== 'declined').map((t) => ({ id: String(t.id), title: String(t.title) })),
      defects: defectRows.filter((d) => d.classification === 'product_defect' && d.status !== 'verified' && d.status !== 'wontfix').map((d) => ({ id: String(d.id), title: String(d.title) })),
      changeRequests: rows(crs.data).filter((c) => c.status === 'approved' && c.classification !== 'new_project').map((c) => ({ id: String(c.id), title: String(c.requested).slice(0, 80) })),
      plans: planRows.map((p) => ({ id: String(p.id), name: String(p.name) })),
      invoices: rows(invoices.data).filter((i) => ['issued', 'partially_paid', 'overdue'].includes(String(i.status))).map((i) => ({ id: String(i.id), number: String(i.number) })),
    },
  };
}
