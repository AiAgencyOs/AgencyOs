import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads for the Phase 9 finance close screens. Every read refuses on failure (G-054): an unreadable queue must not render as an empty one. The position
 * itself is computed by the database (`finance.project_close_position`) from VERIFIED money only; nothing here recomputes, rounds or promotes a figure.
 * All of these tables are readable by Finance and Admin only (RLS), so a failed or empty read here is the database's answer, not a UI decision.
 */

type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

export type Blocker = { code: string; reason: string; ref: string | null; waivable: boolean; amountMinor: number | null };
export type MilestoneLine = {
  milestoneId: string | null; name: string; operationalStatus: string | null; plannedMinor: number; invoicedMinor: number; collectedMinor: number;
  refundedMinor: number; verifiedNetMinor: number; waivedMinor: number; outstandingMinor: number; overdueMinor: number; unverifiedMinor: number;
};
export type ClosePosition = {
  projectId: string;
  projectName: string;
  currency: string;
  result: 'clear' | 'outstanding_only' | 'blocked';
  totals: Record<string, number>;
  marginPercent: number | null;
  marginBasis: string;
  milestones: MilestoneLine[];
  aging: { current: number; days1to30: number; days31to60: number; days61to90: number; over90: number };
  blockers: Blocker[];
};

function toPosition(raw: unknown): ClosePosition | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Row;
  const t = (r.totals ?? {}) as Row;
  const a = (r.aging ?? {}) as Row;
  const totals: Record<string, number> = {};
  for (const [k, v] of Object.entries(t)) if (typeof v === 'number') totals[k] = v;
  const result = r.result === 'clear' || r.result === 'outstanding_only' ? r.result : 'blocked';
  return {
    projectId: String(r.projectId),
    projectName: String(r.projectName ?? ''),
    currency: String(r.currency ?? 'INR'),
    result,
    totals,
    marginPercent: typeof t.marginPercent === 'number' ? t.marginPercent : null,
    marginBasis: String(t.marginBasis ?? ''),
    milestones: rows(r.milestones).map((m) => ({
      milestoneId: str(m.milestoneId), name: String(m.name ?? ''), operationalStatus: str(m.operationalStatus), plannedMinor: num(m.plannedMinor), invoicedMinor: num(m.invoicedMinor),
      collectedMinor: num(m.collectedMinor), refundedMinor: num(m.refundedMinor), verifiedNetMinor: num(m.verifiedNetMinor), waivedMinor: num(m.waivedMinor),
      outstandingMinor: num(m.outstandingMinor), overdueMinor: num(m.overdueMinor), unverifiedMinor: num(m.unverifiedMinor),
    })),
    aging: { current: num(a.current), days1to30: num(a.days1to30), days31to60: num(a.days31to60), days61to90: num(a.days61to90), over90: num(a.over90) },
    blockers: rows(r.blockers).map((b) => ({ code: String(b.code), reason: String(b.reason ?? ''), ref: str(b.ref), waivable: b.waivable === true, amountMinor: typeof b.amountMinor === 'number' ? b.amountMinor : null })),
  };
}

/** The live position of one project, or null when it is not visible to the caller (another organization, or a role that reads no finance). */
export async function readClosePosition(projectId: string): Promise<ClosePosition | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('project_close_position' as never, { p_project_id: projectId } as never);
  if (error) unreadable('readClosePosition', error);
  return toPosition(data);
}

export type ProjectCloseRow = { projectId: string; name: string; code: string | null; status: string; closedMode: string | null; closedAt: string | null; lastResult: string | null; lastEvaluatedAt: string | null };

/** Every project with the state of its financial close: closed (and how) or the result of the last evaluation. */
export async function listProjectCloses(limit = 100): Promise<ProjectCloseRow[]> {
  const supabase = await createClient();
  const [projects, closes, evals] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name, project_code, status').is('deleted_at', null).order('created_at', { ascending: false }).limit(limit),
    supabase.schema('finance').from('project_financial_closes' as never).select('project_id, mode, closed_at').limit(1000),
    supabase.schema('finance').from('financial_close_evaluations' as never).select('project_id, result, created_at').order('created_at', { ascending: false }).limit(1000),
  ]);
  if (projects.error) unreadable('listProjectCloses.projects', projects.error);
  if (closes.error) unreadable('listProjectCloses.closes', closes.error);
  if (evals.error) unreadable('listProjectCloses.evaluations', evals.error);
  const closeBy = new Map(rows(closes.data).map((c) => [String(c.project_id), c]));
  const lastEval = new Map<string, Row>();
  for (const e of rows(evals.data)) if (!lastEval.has(String(e.project_id))) lastEval.set(String(e.project_id), e);
  return rows(projects.data).map((p) => {
    const c = closeBy.get(String(p.id));
    const e = lastEval.get(String(p.id));
    return {
      projectId: String(p.id), name: String(p.name), code: str(p.project_code), status: String(p.status),
      closedMode: c ? str(c.mode) : null, closedAt: c ? str(c.closed_at) : null, lastResult: e ? str(e.result) : null, lastEvaluatedAt: e ? str(e.created_at) : null,
    };
  });
}

export type ExceptionRowView = { id: string; kind: string; blocking: boolean; state: string; reason: string; projectId: string | null; invoiceId: string | null; invoiceNumber: string | null; openedAt: string; openedBySystem: boolean; resolutionNote: string | null; resolvedAt: string | null };

/** The exception queue, open first, then newest, with the resolution trail on the resolved ones. */
export async function listFinanceExceptions(opts: { projectId?: string; limit?: number } = {}): Promise<ExceptionRowView[]> {
  const supabase = await createClient();
  let q = supabase.schema('finance').from('finance_exceptions' as never)
    .select('id, kind, blocking, state, reason, project_id, invoice_id, opened_at, opened_by_system, resolution_note, resolved_at')
    .order('state', { ascending: true }).order('opened_at', { ascending: false }).limit(opts.limit ?? 200);
  if (opts.projectId) q = q.eq('project_id', opts.projectId);
  const { data, error } = await q;
  if (error) unreadable('listFinanceExceptions', error);
  const list = rows(data);
  const invoiceIds = [...new Set(list.map((e) => str(e.invoice_id)).filter((x): x is string => x !== null))];
  const numbers = new Map<string, string>();
  if (invoiceIds.length > 0) {
    const inv = await supabase.schema('finance').from('invoices').select('id, number').in('id', invoiceIds);
    if (inv.error) unreadable('listFinanceExceptions.invoices', inv.error);
    for (const i of inv.data ?? []) numbers.set(String(i.id), String(i.number));
  }
  return list.map((e) => ({
    id: String(e.id), kind: String(e.kind), blocking: e.blocking === true, state: String(e.state), reason: String(e.reason ?? ''), projectId: str(e.project_id), invoiceId: str(e.invoice_id),
    invoiceNumber: str(e.invoice_id) ? (numbers.get(String(e.invoice_id)) ?? null) : null, openedAt: String(e.opened_at), openedBySystem: e.opened_by_system === true,
    resolutionNote: str(e.resolution_note), resolvedAt: str(e.resolved_at),
  }));
}

export type WaiverView = { id: string; invoiceId: string; invoiceNumber: string | null; amountMinor: number; reason: string; status: string; requestedAt: string; decisionNote: string | null; projectId: string | null };
export type CloseExceptionView = { id: string; projectId: string; reason: string; outstandingMinor: number; status: string; requestedAt: string; decisionNote: string | null };

export async function listWaivers(opts: { projectId?: string } = {}): Promise<WaiverView[]> {
  const supabase = await createClient();
  let q = supabase.schema('finance').from('waivers' as never).select('id, invoice_id, project_id, amount_minor, reason, status, requested_at, decision_note').order('requested_at', { ascending: false }).limit(200);
  if (opts.projectId) q = q.eq('project_id', opts.projectId);
  const { data, error } = await q;
  if (error) unreadable('listWaivers', error);
  const list = rows(data);
  const ids = [...new Set(list.map((w) => String(w.invoice_id)))];
  const numbers = new Map<string, string>();
  if (ids.length > 0) {
    const inv = await supabase.schema('finance').from('invoices').select('id, number').in('id', ids);
    if (inv.error) unreadable('listWaivers.invoices', inv.error);
    for (const i of inv.data ?? []) numbers.set(String(i.id), String(i.number));
  }
  return list.map((w) => ({
    id: String(w.id), invoiceId: String(w.invoice_id), invoiceNumber: numbers.get(String(w.invoice_id)) ?? null, amountMinor: num(w.amount_minor), reason: String(w.reason ?? ''),
    status: String(w.status), requestedAt: String(w.requested_at), decisionNote: str(w.decision_note), projectId: str(w.project_id),
  }));
}

export async function listCloseExceptions(projectId: string): Promise<CloseExceptionView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').from('close_exceptions' as never)
    .select('id, project_id, reason, outstanding_at_request_minor, status, requested_at, decision_note').eq('project_id', projectId).order('requested_at', { ascending: false }).limit(50);
  if (error) unreadable('listCloseExceptions', error);
  return rows(data).map((x) => ({ id: String(x.id), projectId: String(x.project_id), reason: String(x.reason ?? ''), outstandingMinor: num(x.outstanding_at_request_minor), status: String(x.status), requestedAt: String(x.requested_at), decisionNote: str(x.decision_note) }));
}

export type ProposalView = {
  id: string; agentKey: string; kind: string; summary: string; detail: string | null; evidenceRefs: string[]; draftBody: string | null; amountMinor: number | null;
  proposedExceptionKind: string | null; createdAt: string; decision: 'accepted' | 'rejected' | null; decisionNote: string | null; recordedOutcome: string | null; projectId: string;
};

/** The agents' proposals for one project (or all), each with the one decision a person made on it. */
export async function listFinanceProposals(opts: { projectId?: string; limit?: number } = {}): Promise<ProposalView[]> {
  const supabase = await createClient();
  let q = supabase.schema('finance').from('finance_proposals' as never)
    .select('id, project_id, agent_key, kind, summary, detail, evidence_refs, draft_body, amount_minor, proposed_exception_kind, created_at').order('created_at', { ascending: false }).limit(opts.limit ?? 100);
  if (opts.projectId) q = q.eq('project_id', opts.projectId);
  const { data, error } = await q;
  if (error) unreadable('listFinanceProposals', error);
  const list = rows(data);
  if (list.length === 0) return [];
  const decisions = await supabase.schema('finance').from('finance_proposal_decisions' as never).select('proposal_id, decision, note, recorded_outcome').in('proposal_id', list.map((p) => String(p.id)));
  if (decisions.error) unreadable('listFinanceProposals.decisions', decisions.error);
  const byProposal = new Map(rows(decisions.data).map((d) => [String(d.proposal_id), d]));
  return list.map((p) => {
    const d = byProposal.get(String(p.id));
    return {
      id: String(p.id), projectId: String(p.project_id), agentKey: String(p.agent_key), kind: String(p.kind), summary: String(p.summary ?? ''), detail: str(p.detail),
      evidenceRefs: Array.isArray(p.evidence_refs) ? (p.evidence_refs as unknown[]).map(String) : [], draftBody: str(p.draft_body), amountMinor: typeof p.amount_minor === 'number' ? p.amount_minor : null,
      proposedExceptionKind: str(p.proposed_exception_kind), createdAt: String(p.created_at),
      decision: d && (d.decision === 'accepted' || d.decision === 'rejected') ? d.decision : null, decisionNote: d ? str(d.note) : null, recordedOutcome: d ? str(d.recorded_outcome) : null,
    };
  });
}

export type PeriodCloseView = { id: string; periodStart: string; periodEnd: string; label: string; collectedMinor: number; refundedMinor: number; waivedMinor: number; expensedMinor: number; netMinor: number; exceptionCount: number; acknowledgement: string | null; closedAt: string };

export async function listPeriodCloses(): Promise<PeriodCloseView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').from('period_closes' as never)
    .select('id, period_start, period_end, label, collected_minor, refunded_minor, waived_minor, expensed_minor, net_minor, exceptions, acknowledgement, closed_at').order('period_start', { ascending: false }).limit(60);
  if (error) unreadable('listPeriodCloses', error);
  return rows(data).map((p) => ({
    id: String(p.id), periodStart: String(p.period_start), periodEnd: String(p.period_end), label: String(p.label), collectedMinor: num(p.collected_minor), refundedMinor: num(p.refunded_minor),
    waivedMinor: num(p.waived_minor), expensedMinor: num(p.expensed_minor), netMinor: num(p.net_minor), exceptionCount: Array.isArray(p.exceptions) ? p.exceptions.length : 0, acknowledgement: str(p.acknowledgement), closedAt: String(p.closed_at),
  }));
}

export type PeriodPreview = {
  periodStart: string; periodEnd: string; invoicedMinor: number; invoicedCount: number; collectedMinor: number; refundedMinor: number; waivedMinor: number; expensedMinor: number; unverifiedMinor: number;
  revenueMinor: number; netMinor: number; basis: string;
  projects: { projectId: string; projectName: string; invoicedMinor: number; collectedMinor: number; refundedMinor: number; expensedMinor: number; marginMinor: number }[];
  exceptions: { source: string; kind: string; blocking: boolean; reason: string }[];
};

/** The report as it would be frozen (the same SQL the close uses), or null when the period is invalid or the caller reads no finance. */
export async function previewPeriod(start: string, end: string): Promise<PeriodPreview | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('period_close_preview' as never, { p_period_start: start, p_period_end: end } as never);
  if (error) unreadable('previewPeriod', error);
  if (!data || typeof data !== 'object') return null;
  const r = data as Row;
  const inv = (r.invoiced ?? {}) as Row;
  const pl = (r.profitAndLoss ?? {}) as Row;
  return {
    periodStart: String(r.periodStart), periodEnd: String(r.periodEnd), invoicedMinor: num(inv.minor), invoicedCount: num(inv.count), collectedMinor: num(r.collectedMinor), refundedMinor: num(r.refundedMinor),
    waivedMinor: num(r.waivedMinor), expensedMinor: num(r.expensedMinor), unverifiedMinor: num(r.unverifiedMinor), revenueMinor: num(pl.revenueMinor), netMinor: num(pl.netMinor), basis: String(r.basis ?? ''),
    projects: rows(r.projects).map((p) => ({ projectId: String(p.projectId), projectName: String(p.projectName), invoicedMinor: num(p.invoicedMinor), collectedMinor: num(p.collectedMinor), refundedMinor: num(p.refundedMinor), expensedMinor: num(p.expensedMinor), marginMinor: num(p.marginMinor) })),
    exceptions: rows(r.exceptions).map((e) => ({ source: String(e.source), kind: String(e.kind), blocking: e.blocking === true, reason: String(e.reason ?? '') })),
  };
}

/** Where one project's close stands, for the project page: closed (how) or the last evaluation. Null when nothing is on record or the caller reads no finance. */
export async function readProjectCloseSummary(projectId: string): Promise<{ closedMode: string | null; closedAt: string | null; lastResult: string | null } | null> {
  const supabase = await createClient();
  const [close, evaluation] = await Promise.all([
    supabase.schema('finance').from('project_financial_closes' as never).select('mode, closed_at').eq('project_id', projectId).limit(1),
    supabase.schema('finance').from('financial_close_evaluations' as never).select('result, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1),
  ]);
  if (close.error) unreadable('readProjectCloseSummary.close', close.error);
  if (evaluation.error) unreadable('readProjectCloseSummary.evaluation', evaluation.error);
  const c = rows(close.data)[0];
  const e = rows(evaluation.data)[0];
  if (!c && !e) return null;
  return { closedMode: c ? str(c.mode) : null, closedAt: c ? str(c.closed_at) : null, lastResult: e ? str(e.result) : null };
}
