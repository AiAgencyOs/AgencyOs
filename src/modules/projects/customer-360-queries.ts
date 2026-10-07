import 'server-only';

import { createClient } from '@/lib/db/server';
import { isLiveInvoice, verifiedOn } from '@/lib/finance/verified-basis';
import { unreadable } from '@/lib/result';

import { LIFECYCLE_PHASE_LABEL } from './project-archive-schema';
import { readProjectLifecycles } from './project-lifecycle-queries';
import { parseFacts, type ValueFact } from './value-report';

/**
 * Customer 360 (Phase 8 P8-ADM-001): ONE client across ALL of its projects, for internal staff.
 *
 * Every figure is read as stored, or from the database function that derives it: health from `customer_health_status` (never stored on a row), SLA state
 * from `support_queue`, eligibility from `can_contact_now`. Nothing here computes a status, an SLA clock, a coverage decision, a price or an eligibility. A read
 * that fails is refused (G-054), never rendered as an empty section: someone who sees "no tickets" must be seeing no tickets.
 *
 * Finance is read ONLY when the caller says the viewer may read it (the page passes `can(context, 'invoice.read')`); otherwise the invoice section is
 * absent, not empty, and the type says so (`invoices: null`).
 */

export type C360Project = {
  id: string; name: string; code: string | null; status: string; phase: string; phaseLabel: string; completedAt: string | null;
  phaseEight: { state: string; warrantyEndsOn: string | null; csOwner: string | null } | null;
};
export type C360Plan = { id: string; projectId: string; projectName: string; name: string; version: number; status: string; startsOn: string | null; endsOn: string | null; billingModel: string };
export type C360Ticket = {
  id: string; projectId: string; projectName: string; ref: string; title: string; status: string; priority: string | null; classification: string | null; coverageDecision: string | null;
  raisedAt: string; closedAt: string | null; responseState: string; resolutionState: string; resolutionDueAt: string | null; open: boolean;
};
export type C360Health = { projectId: string; projectName: string; status: string; signals: { signal: string; value: string; level: string; detail: string }[] };
export type C360Recovery = { id: string; projectId: string; projectName: string; status: string; ownerId: string | null; deadline: string | null; rootCause: string | null; outcome: string | null };
export type C360CheckIn = { id: string; projectId: string; projectName: string; kind: string; status: string; dueOn: string; engagement: string | null; channel: string | null; outcome: string | null };
export type C360Opportunity = { id: string; projectId: string; projectName: string; kind: string; need: string; status: string; urgency: string; suppressedReason: string | null };
export type C360Invoice = { id: string; number: string; projectId: string | null; status: string; currency: string; totalMinor: number; verifiedMinor: number; outstandingMinor: number; dueAt: string | null; live: boolean };
export type C360Renewal = { planId: string; projectName: string; planName: string; status: string; endsOn: string };
export type C360Contact = { id: string; name: string; whatsappConsent: 'granted' | 'withdrawn' | 'none' };
export type C360Cap = { id: string; channel: string | null; maxContacts: number; windowDays: number; active: boolean };
export type C360QuietPeriod = { id: string; startsAt: string; endsAt: string; reason: string; cancelledAt: string | null };
export type C360LedgerRow = {
  id: string; occurredAt: string; channel: string; purpose: string; entryKind: string; summary: string; eligibleAtRecord: boolean | null; eligibilityReasons: string[];
  deliveryState: string; deliverySource: string; replied: boolean; recordedBy: string | null; draftedByAgent: string | null;
};
export type C360Eligibility = { channel: string; purpose: string; allowed: boolean; reasons: string[] };
export type C360ValueReport = {
  id: string; periodStart: string; periodEnd: string; templateVersion: number; status: string; body: string; builtByAgent: string | null; builtAt: string; factCount: number;
  facts: ValueFact[]; approvedAt: string | null;
};

export type Customer360 = {
  client: { id: string; name: string; status: string; currency: string };
  projects: C360Project[];
  plans: C360Plan[];
  renewals: C360Renewal[];
  tickets: C360Ticket[];
  health: C360Health[];
  recovery: C360Recovery[];
  checkIns: C360CheckIn[];
  opportunities: C360Opportunity[];
  /** null = the viewer may not read finance: the section is not shown, which is not the same as having no invoices. */
  invoices: C360Invoice[] | null;
  outstandingByCurrency: { currency: string; outstandingMinor: number }[] | null;
  contacts: C360Contact[];
  caps: C360Cap[];
  quietPeriods: C360QuietPeriod[];
  ledger: C360LedgerRow[];
  eligibility: C360Eligibility[];
  valueReports: C360ValueReport[];
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** Channels and purposes the eligibility panel asks about: every channel for a relationship message, and the other two purposes on WhatsApp. */
export const ELIGIBILITY_QUESTIONS: readonly { channel: string; purpose: string }[] = [
  { channel: 'whatsapp', purpose: 'operational' },
  { channel: 'whatsapp', purpose: 'relationship' },
  { channel: 'whatsapp', purpose: 'commercial' },
  { channel: 'email', purpose: 'relationship' },
  { channel: 'portal', purpose: 'relationship' },
  { channel: 'call', purpose: 'relationship' },
  { channel: 'meeting', purpose: 'relationship' },
];

export async function readCustomer360(clientId: string, options: { mayReadFinance: boolean }): Promise<Customer360 | null> {
  const supabase = await createClient();
  const projects = supabase.schema('projects');

  const { data: clientRow, error: clientError } = await supabase.schema('core').from('client_accounts').select('id, name, status, currency').eq('id', clientId).maybeSingle();
  if (clientError) unreadable('readCustomer360.client', clientError);
  if (!clientRow) return null;

  const { data: projectRows, error: projectError } = await projects.from('projects').select('id, name, project_code, status, completed_at').eq('client_account_id', clientId).is('deleted_at', null).order('created_at', { ascending: false }).limit(200);
  if (projectError) unreadable('readCustomer360.projects', projectError);
  const projectList = projectRows ?? [];
  const projectIds = projectList.map((p) => String(p.id));
  const nameOf = new Map(projectList.map((p) => [String(p.id), String(p.name)]));
  const base = { client: { id: String(clientRow.id), name: String(clientRow.name), status: String(clientRow.status), currency: String(clientRow.currency) } };

  const lifecycles = projectIds.length > 0 ? await readProjectLifecycles() : new Map();

  const none = { data: [] as unknown[], error: null };
  const [workspaces, plans, recovery, checkIns, opportunities, contacts, caps, quiet, reports] = await Promise.all([
    projectIds.length ? projects.from('phase_eight' as never).select('project_id, state, warranty_ends_on, cs_owner').in('project_id' as never, projectIds as never) : none,
    projectIds.length ? projects.from('maintenance_plans').select('id, project_id, name, version, status, starts_on, ends_on, billing_model').in('project_id', projectIds).order('ends_on', { ascending: true }).limit(200) : none,
    projectIds.length ? projects.from('recovery_plans' as never).select('id, project_id, status, owner_id, deadline, root_cause, outcome').in('project_id' as never, projectIds as never).order('created_at' as never, { ascending: false }).limit(100) : none,
    projectIds.length ? projects.from('cs_check_ins' as never).select('id, project_id, kind, status, due_on, engagement, channel, outcome').in('project_id' as never, projectIds as never).order('due_on' as never, { ascending: false }).limit(100) : none,
    projectIds.length ? supabase.schema('sales').from('phase_eight_opportunities' as never).select('id, project_id, kind, need, status, urgency, suppressed_reason').in('project_id' as never, projectIds as never).order('created_at' as never, { ascending: false }).limit(100) : none,
    supabase.schema('crm').from('contacts').select('id, full_name').eq('client_account_id', clientId).limit(200),
    projects.from('client_communication_caps' as never).select('id, channel, max_contacts, window_days, active').eq('client_account_id' as never, clientId as never).limit(20),
    projects.from('client_quiet_periods' as never).select('id, starts_at, ends_at, reason, cancelled_at').eq('client_account_id' as never, clientId as never).order('starts_at' as never, { ascending: false }).limit(20),
    projects.from('value_report_drafts' as never).select('id, period_start, period_end, template_version, status, body, built_by_agent, built_at, facts, approved_at').eq('client_account_id' as never, clientId as never).order('built_at' as never, { ascending: false }).limit(10),
  ]);
  if (workspaces.error) unreadable('readCustomer360.workspaces', workspaces.error);
  if (plans.error) unreadable('readCustomer360.plans', plans.error);
  if (recovery.error) unreadable('readCustomer360.recovery', recovery.error);
  if (checkIns.error) unreadable('readCustomer360.checkIns', checkIns.error);
  if (opportunities.error) unreadable('readCustomer360.opportunities', opportunities.error);
  if (contacts.error) unreadable('readCustomer360.contacts', contacts.error);
  if (caps.error) unreadable('readCustomer360.caps', caps.error);
  if (quiet.error) unreadable('readCustomer360.quiet', quiet.error);
  if (reports.error) unreadable('readCustomer360.reports', reports.error);

  const workspaceByProject = new Map(rows(workspaces.data).map((w) => [String(w.project_id), w]));
  const phaseEightIds = [...workspaceByProject.keys()];

  // derived reads, one per live Phase 8 workspace: health and the ticket queue
  const [healthResults, queueResults] = await Promise.all([
    Promise.all(phaseEightIds.map((id) => projects.rpc('customer_health_status' as never, { p_project_id: id } as never))),
    Promise.all(phaseEightIds.map((id) => projects.rpc('support_queue' as never, { p_project_id: id } as never))),
  ]);
  const health: C360Health[] = [];
  healthResults.forEach((r, i) => {
    if (r.error) unreadable('readCustomer360.health', r.error);
    const row = (Array.isArray(r.data) ? r.data[0] : r.data) as { status?: string; reasons?: C360Health['signals'] } | undefined;
    const id = phaseEightIds[i]!;
    if (row?.status) health.push({ projectId: id, projectName: nameOf.get(id) ?? id, status: row.status, signals: Array.isArray(row.reasons) ? row.reasons : [] });
  });
  const tickets: C360Ticket[] = [];
  queueResults.forEach((r, i) => {
    if (r.error) unreadable('readCustomer360.queue', r.error);
    const id = phaseEightIds[i]!;
    for (const t of rows(r.data)) {
      const status = String(t.status);
      tickets.push({
        id: String(t.id), projectId: id, projectName: nameOf.get(id) ?? id, ref: String(t.ticket_ref), title: String(t.title), status, priority: str(t.priority), classification: str(t.classification),
        coverageDecision: str(t.coverage_decision), raisedAt: String(t.raised_at), closedAt: str(t.closed_at), responseState: String(t.response_state), resolutionState: String(t.resolution_state),
        resolutionDueAt: str(t.resolution_due_at), open: status !== 'closed' && status !== 'cancelled',
      });
    }
  });
  tickets.sort((a, b) => Number(b.open) - Number(a.open) || b.raisedAt.localeCompare(a.raisedAt));

  // finance: only where the viewer may read it
  let invoices: C360Invoice[] | null = null;
  let outstandingByCurrency: Customer360['outstandingByCurrency'] = null;
  if (options.mayReadFinance) {
    const { data: invoiceRows, error: invoiceError } = await supabase.schema('finance').from('invoices').select('id, number, project_id, status, currency, total_minor, verified_minor, due_at').eq('client_account_id', clientId).order('created_at', { ascending: false }).limit(200);
    if (invoiceError) unreadable('readCustomer360.invoices', invoiceError);
    invoices = (invoiceRows ?? []).map((i) => {
      const live = isLiveInvoice(String(i.status));
      const total = Number(i.total_minor);
      const verified = verifiedOn({ total_minor: total, verified_minor: Number(i.verified_minor) });
      return { id: String(i.id), number: String(i.number), projectId: str(i.project_id), status: String(i.status), currency: String(i.currency), totalMinor: total, verifiedMinor: verified, outstandingMinor: live ? total - verified : 0, dueAt: str(i.due_at), live };
    });
    const totals = new Map<string, number>();
    for (const i of invoices) if (i.live) totals.set(i.currency, (totals.get(i.currency) ?? 0) + i.outstandingMinor);
    outstandingByCurrency = [...totals.entries()].map(([currency, outstandingMinor]) => ({ currency, outstandingMinor }));
  }

  // communication: consent per contact, the ledger with delivery state, the eligibility answers
  const contactIds = (contacts.data ?? []).map((c) => String(c.id));
  const { data: consentRows, error: consentError } = contactIds.length
    ? await supabase.schema('crm').from('communication_consent').select('contact_id, status').eq('channel', 'whatsapp').in('contact_id', contactIds)
    : { data: [] as { contact_id: string; status: string }[], error: null };
  if (consentError) unreadable('readCustomer360.consent', consentError);
  const consentOf = new Map((consentRows ?? []).map((c) => [String(c.contact_id), String(c.status)]));

  const { data: ledgerRows, error: ledgerError } = await projects.rpc('client_communication_history' as never, { p_client_account_id: clientId, p_limit: 30 } as never);
  if (ledgerError) unreadable('readCustomer360.ledger', ledgerError);

  const eligibilityResults = await Promise.all(ELIGIBILITY_QUESTIONS.map((q) => projects.rpc('can_contact_now' as never, { p_client_account_id: clientId, p_channel: q.channel, p_purpose: q.purpose } as never)));
  const eligibility: C360Eligibility[] = [];
  eligibilityResults.forEach((r, i) => {
    if (r.error) unreadable('readCustomer360.eligibility', r.error);
    const row = (Array.isArray(r.data) ? r.data[0] : r.data) as { allowed?: boolean; reasons?: unknown } | undefined;
    const q = ELIGIBILITY_QUESTIONS[i]!;
    // an answer that did not come back is not "allowed": it is shown as not allowed with that reason
    eligibility.push({ channel: q.channel, purpose: q.purpose, allowed: row?.allowed === true, reasons: row ? (Array.isArray(row.reasons) ? (row.reasons as unknown[]).map(String) : []) : ['no answer was returned'] });
  });

  const planRows = rows(plans.data);
  const renewalStatuses = new Set(['renewal_approaching', 'renewal_proposed', 'pending_client', 'expired']);

  return {
    ...base,
    projects: projectList.map((p) => {
      const id = String(p.id);
      const phase = (lifecycles.get(id)?.phase as string | undefined) ?? 'planning';
      const w = workspaceByProject.get(id);
      return {
        id, name: String(p.name), code: str(p.project_code), status: String(p.status), phase, phaseLabel: LIFECYCLE_PHASE_LABEL[phase as keyof typeof LIFECYCLE_PHASE_LABEL] ?? phase, completedAt: str(p.completed_at),
        phaseEight: w ? { state: String(w.state), warrantyEndsOn: str(w.warranty_ends_on), csOwner: str(w.cs_owner) } : null,
      };
    }),
    plans: planRows.map((p) => ({
      id: String(p.id), projectId: String(p.project_id), projectName: nameOf.get(String(p.project_id)) ?? String(p.project_id), name: String(p.name), version: Number(p.version), status: String(p.status),
      startsOn: str(p.starts_on), endsOn: str(p.ends_on), billingModel: String(p.billing_model),
    })),
    renewals: planRows
      .filter((p) => str(p.ends_on) !== null && (renewalStatuses.has(String(p.status)) || String(p.status) === 'active' || String(p.status) === 'renewed'))
      .map((p) => ({ planId: String(p.id), projectName: nameOf.get(String(p.project_id)) ?? String(p.project_id), planName: String(p.name), status: String(p.status), endsOn: String(p.ends_on) }))
      .sort((a, b) => a.endsOn.localeCompare(b.endsOn)),
    tickets,
    health,
    recovery: rows(recovery.data).map((r) => ({
      id: String(r.id), projectId: String(r.project_id), projectName: nameOf.get(String(r.project_id)) ?? String(r.project_id), status: String(r.status), ownerId: str(r.owner_id), deadline: str(r.deadline), rootCause: str(r.root_cause), outcome: str(r.outcome),
    })),
    checkIns: rows(checkIns.data).map((c) => ({
      id: String(c.id), projectId: String(c.project_id), projectName: nameOf.get(String(c.project_id)) ?? String(c.project_id), kind: String(c.kind), status: String(c.status), dueOn: String(c.due_on),
      engagement: str(c.engagement), channel: str(c.channel), outcome: str(c.outcome),
    })),
    opportunities: rows(opportunities.data).map((o) => ({
      id: String(o.id), projectId: String(o.project_id), projectName: nameOf.get(String(o.project_id)) ?? String(o.project_id), kind: String(o.kind), need: String(o.need), status: String(o.status), urgency: String(o.urgency),
      suppressedReason: str(o.suppressed_reason),
    })),
    invoices,
    outstandingByCurrency,
    contacts: (contacts.data ?? []).map((c) => ({ id: String(c.id), name: String(c.full_name), whatsappConsent: consentOf.get(String(c.id)) === 'granted' ? 'granted' : consentOf.get(String(c.id)) === 'withdrawn' ? 'withdrawn' : 'none' })),
    caps: rows(caps.data).map((c) => ({ id: String(c.id), channel: str(c.channel), maxContacts: Number(c.max_contacts), windowDays: Number(c.window_days), active: c.active === true })),
    quietPeriods: rows(quiet.data).map((q) => ({ id: String(q.id), startsAt: String(q.starts_at), endsAt: String(q.ends_at), reason: String(q.reason), cancelledAt: str(q.cancelled_at) })),
    ledger: rows(ledgerRows).map((l) => ({
      id: String(l.id), occurredAt: String(l.occurred_at), channel: String(l.channel), purpose: String(l.purpose), entryKind: String(l.entry_kind), summary: String(l.summary),
      eligibleAtRecord: typeof l.eligible_at_record === 'boolean' ? l.eligible_at_record : null, eligibilityReasons: Array.isArray(l.eligibility_reasons) ? (l.eligibility_reasons as unknown[]).map(String) : [],
      deliveryState: String(l.delivery_state), deliverySource: String(l.delivery_source), replied: l.replied === true, recordedBy: str(l.recorded_by), draftedByAgent: str(l.drafted_by_agent),
    })),
    eligibility,
    valueReports: rows(reports.data).map((r) => {
      const facts = parseFacts(r.facts);
      return {
        id: String(r.id), periodStart: String(r.period_start), periodEnd: String(r.period_end), templateVersion: Number(r.template_version), status: String(r.status), body: String(r.body),
        builtByAgent: str(r.built_by_agent), builtAt: String(r.built_at), factCount: facts.length, facts, approvedAt: str(r.approved_at),
      };
    }),
  };
}

/** The facts and digest for a client and period, straight from the database read; null when the period is not valid or the client is not visible. */
export async function readValueReportFacts(clientId: string, periodStart: string, periodEnd: string): Promise<{ facts: ValueFact[]; digest: string; clientName: string } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('value_report_facts' as never, { p_client_account_id: clientId, p_start: periodStart, p_end: periodEnd } as never);
  if (error) unreadable('readValueReportFacts', error);
  const row = (Array.isArray(data) ? data[0] : data) as { facts?: unknown; digest?: unknown } | undefined;
  if (!row || typeof row.digest !== 'string') return null;
  const { data: clientRow, error: clientError } = await supabase.schema('core').from('client_accounts').select('name').eq('id', clientId).maybeSingle();
  if (clientError) unreadable('readValueReportFacts.client', clientError);
  if (!clientRow) return null;
  return { facts: parseFacts(row.facts), digest: row.digest, clientName: String(clientRow.name) };
}
