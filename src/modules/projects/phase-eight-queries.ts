import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Phase 8A (Customer Success, Support, Upsell, post-launch Sales) for the Admin.
 *
 * Everything is read as stored, or from the database function that DERIVES it: health comes from `customer_health_status` (never stored on a
 * row), SLA states from `support_queue`, eligibility from `check_in_eligibility`. Nothing here computes a status, a clock or a coverage decision. A
 * failed read is `unreadable` (G-054), never an empty section: an Admin who sees "no tickets" must be seeing no tickets.
 */

export type Gate = { id: string; label: string; at: 'intake' | 'start'; passed: boolean; waived: boolean; detail: string };
export type IntakeView = { status: 'incomplete' | 'ready'; source: string; refreshedAt: string; gates: Gate[]; blockers: { id: string; detail: string }[]; package: Record<string, unknown> };
export type WorkspaceView = {
  id: string; state: 'active' | 'paused' | 'closed'; stateReason: string | null; csOwner: string | null; warrantyStartsOn: string | null; warrantyEndsOn: string | null;
  warrantyCoverage: string | null; warrantyExclusions: string | null; noWarrantyReason: string | null; startedAt: string;
};
export type HealthSignal = { signal: string; value: string; level: string; detail: string };
export type HealthView = { status: string; signals: HealthSignal[] } | null;
export type SnapshotRow = { id: string; status: string; previousStatus: string | null; trigger: string; computedAt: string };
export type RecoveryPlanRow = { id: string; status: string; ownerId: string | null; rootCause: string | null; actions: string | null; deadline: string | null; outcome: string | null; createdAt: string };
export type TicketRow = {
  id: string; ref: string; title: string; source: string; status: string; classification: string | null; coverageDecision: string | null; coverageReason: string | null; priority: string | null;
  assigneeId: string | null; raisedAt: string; responseState: string; resolutionState: string; responseDueAt: string | null; resolutionDueAt: string | null; escalatedToRole: string | null;
  escalatedAt: string | null; escalationAckAt: string | null; planId: string | null; defectId: string | null; changeRequestId: string | null; maintenanceItemId: string | null;
  opportunityId: string | null; releaseNeeded: boolean; clientConfirmedAt: string | null; proposedClassification: string | null; proposedRationale: string | null;
};
export type ReplyDraftRow = { id: string; ticketId: string; body: string; language: string | null; byAgent: string | null; createdAt: string };
export type CheckInRow = { id: string; kind: string; periodKey: string; dueOn: string; status: string; agenda: string | null; agendaByAgent: string | null; engagement: string | null; channel: string | null; outcome: string | null };
export type EligibilityRow = { category: string; allowed: boolean; reasons: string[] };
export type PlanRow = { id: string; name: string; version: number; status: string; startsOn: string | null; endsOn: string | null };
export type OpportunityRow = {
  id: string; kind: string; need: string; urgency: string; status: string; evidence: { type: string; id: string }[]; suppressedReason: string | null; salesOpportunityId: string | null;
  detectedByAgent: string | null; outcomeReason: string | null;
};
export type Member = { userId: string; label: string; role: string };

export type PhaseEightView = {
  project: { id: string; name: string; status: string; clientAccountId: string };
  intake: IntakeView | null;
  workspace: WorkspaceView | null;
  health: HealthView;
  snapshots: SnapshotRow[];
  recovery: RecoveryPlanRow[];
  tickets: TicketRow[];
  drafts: ReplyDraftRow[];
  checkIns: CheckInRow[];
  eligibility: EligibilityRow[];
  plans: PlanRow[];
  opportunities: OpportunityRow[];
  members: Member[];
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function readPhaseEight(projectId: string): Promise<PhaseEightView | null> {
  const supabase = await createClient();
  const projects = supabase.schema('projects');

  const { data: projectRow, error: projectError } = await projects.from('projects').select('id, name, status, client_account_id').eq('id', projectId).maybeSingle();
  if (projectError) unreadable('readPhaseEight.project', projectError);
  if (!projectRow) return null;

  const { data: workspaceRow, error: workspaceError } = await projects.from('phase_eight' as never).select('*').eq('project_id' as never, projectId as never).maybeSingle();
  if (workspaceError) unreadable('readPhaseEight.workspace', workspaceError);

  const { data: intakeRow, error: intakeError } = await projects.from('phase_eight_intake' as never).select('*').eq('project_id' as never, projectId as never).maybeSingle();
  if (intakeError) unreadable('readPhaseEight.intake', intakeError);

  const w = workspaceRow as Record<string, unknown> | null;
  const i = intakeRow as Record<string, unknown> | null;
  const base = {
    project: { id: String(projectRow.id), name: String(projectRow.name), status: String(projectRow.status), clientAccountId: String(projectRow.client_account_id) },
    intake: i
      ? ({
          status: i.status === 'ready' ? 'ready' : 'incomplete',
          source: String(i.source),
          refreshedAt: String(i.refreshed_at),
          gates: (Array.isArray(i.gates) ? i.gates : []) as Gate[],
          blockers: (Array.isArray(i.blockers) ? i.blockers : []) as { id: string; detail: string }[],
          package: (i.package ?? {}) as Record<string, unknown>,
        } satisfies IntakeView)
      : null,
    workspace: w
      ? ({
          id: String(w.id), state: w.state as WorkspaceView['state'], stateReason: str(w.state_reason), csOwner: str(w.cs_owner), warrantyStartsOn: str(w.warranty_starts_on),
          warrantyEndsOn: str(w.warranty_ends_on), warrantyCoverage: str(w.warranty_coverage), warrantyExclusions: str(w.warranty_exclusions), noWarrantyReason: str(w.no_warranty_reason), startedAt: String(w.started_at),
        } satisfies WorkspaceView)
      : null,
  };

  const { data: memberRows, error: memberError } = await supabase.schema('core').from('memberships').select('user_id, role, status').eq('status', 'active').limit(200);
  if (memberError) unreadable('readPhaseEight.members', memberError);
  const memberIds = (memberRows ?? []).map((m) => String(m.user_id));
  const { data: userRows, error: userError } = memberIds.length
    ? await supabase.schema('core').from('users').select('id, email, full_name').in('id', memberIds)
    : { data: [] as { id: string; email: string | null; full_name: string | null }[], error: null };
  if (userError) unreadable('readPhaseEight.users', userError);
  const labelOf = new Map((userRows ?? []).map((u) => [String(u.id), u.full_name || u.email || String(u.id)]));
  const members: Member[] = (memberRows ?? [])
    .filter((m) => ['owner', 'ops_admin', 'delivery_lead', 'member'].includes(String(m.role)))
    .map((m) => ({ userId: String(m.user_id), label: labelOf.get(String(m.user_id)) ?? String(m.user_id), role: String(m.role) }));

  if (!base.workspace) {
    return { ...base, health: null, snapshots: [], recovery: [], tickets: [], drafts: [], checkIns: [], eligibility: [], plans: [], opportunities: [], members };
  }

  const { data: healthRows, error: healthError } = await projects.rpc('customer_health_status' as never, { p_project_id: projectId } as never);
  if (healthError) unreadable('readPhaseEight.health', healthError);
  const healthRow = (Array.isArray(healthRows) ? healthRows[0] : healthRows) as { status?: string; reasons?: HealthSignal[] } | undefined;
  const health: HealthView = healthRow?.status ? { status: healthRow.status, signals: Array.isArray(healthRow.reasons) ? healthRow.reasons : [] } : null;

  const { data: snapshotRows, error: snapshotError } = await projects.from('customer_health_snapshots' as never).select('id, status, previous_status, trigger, computed_at').eq('project_id' as never, projectId as never).order('seq' as never, { ascending: false }).limit(10);
  if (snapshotError) unreadable('readPhaseEight.snapshots', snapshotError);

  const { data: recoveryRows, error: recoveryError } = await projects.from('recovery_plans' as never).select('id, status, owner_id, root_cause, actions, deadline, outcome, created_at').eq('project_id' as never, projectId as never).order('created_at' as never, { ascending: false }).limit(10);
  if (recoveryError) unreadable('readPhaseEight.recovery', recoveryError);

  const { data: queueRows, error: queueError } = await projects.rpc('support_queue' as never, { p_project_id: projectId } as never);
  if (queueError) unreadable('readPhaseEight.queue', queueError);

  const ticketIds = (Array.isArray(queueRows) ? (queueRows as Record<string, unknown>[]) : []).map((t) => String(t.id));
  const { data: draftRows, error: draftError } = ticketIds.length
    ? await projects.from('support_reply_drafts' as never).select('id, ticket_id, body, language, drafted_by_agent, created_at').eq('status' as never, 'draft' as never).in('ticket_id' as never, ticketIds as never).order('created_at' as never, { ascending: false }).limit(100)
    : { data: [] as unknown[], error: null };
  if (draftError) unreadable('readPhaseEight.drafts', draftError);

  const { data: checkInRows, error: checkInError } = await projects.from('cs_check_ins' as never).select('id, kind, period_key, due_on, status, agenda, agenda_by_agent, engagement, channel, outcome').eq('project_id' as never, projectId as never).order('due_on' as never, { ascending: false }).limit(30);
  if (checkInError) unreadable('readPhaseEight.checkIns', checkInError);

  const { data: eligibilityRows, error: eligibilityError } = await projects.rpc('check_in_eligibility' as never, { p_project_id: projectId } as never);
  if (eligibilityError) unreadable('readPhaseEight.eligibility', eligibilityError);

  const { data: planRows, error: planError } = await projects.from('maintenance_plans').select('id, name, version, status, starts_on, ends_on').eq('project_id', projectId).order('starts_on', { ascending: false }).limit(20);
  if (planError) unreadable('readPhaseEight.plans', planError);

  const { data: opportunityRows, error: opportunityError } = await supabase.schema('sales').from('phase_eight_opportunities' as never).select('id, kind, need, urgency, status, evidence, suppressed_reason, sales_opportunity_id, detected_by_agent, outcome_reason').eq('project_id' as never, projectId as never).order('created_at' as never, { ascending: false }).limit(30);
  if (opportunityError) unreadable('readPhaseEight.opportunities', opportunityError);

  const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    ...base,
    health,
    snapshots: rows(snapshotRows).map((s) => ({ id: String(s.id), status: String(s.status), previousStatus: str(s.previous_status), trigger: String(s.trigger), computedAt: String(s.computed_at) })),
    recovery: rows(recoveryRows).map((r) => ({ id: String(r.id), status: String(r.status), ownerId: str(r.owner_id), rootCause: str(r.root_cause), actions: str(r.actions), deadline: str(r.deadline), outcome: str(r.outcome), createdAt: String(r.created_at) })),
    tickets: rows(queueRows).map((t) => ({
      id: String(t.id), ref: String(t.ticket_ref), title: String(t.title), source: String(t.source), status: String(t.status), classification: str(t.classification), coverageDecision: str(t.coverage_decision),
      coverageReason: str(t.coverage_reason), priority: str(t.priority), assigneeId: str(t.assignee_id), raisedAt: String(t.raised_at), responseState: String(t.response_state), resolutionState: String(t.resolution_state),
      responseDueAt: str(t.response_due_at), resolutionDueAt: str(t.resolution_due_at), escalatedToRole: str(t.escalated_to_role), escalatedAt: str(t.escalated_at), escalationAckAt: str(t.escalation_ack_at),
      planId: str(t.plan_id), defectId: str(t.defect_id), changeRequestId: str(t.change_request_id), maintenanceItemId: str(t.maintenance_item_id), opportunityId: str(t.opportunity_id),
      releaseNeeded: t.release_needed === true, clientConfirmedAt: str(t.client_confirmed_at), proposedClassification: str(t.proposed_classification), proposedRationale: str(t.proposed_rationale),
    })),
    drafts: rows(draftRows).map((d) => ({ id: String(d.id), ticketId: String(d.ticket_id), body: String(d.body), language: str(d.language), byAgent: str(d.drafted_by_agent), createdAt: String(d.created_at) })),
    checkIns: rows(checkInRows).map((c) => ({ id: String(c.id), kind: String(c.kind), periodKey: String(c.period_key), dueOn: String(c.due_on), status: String(c.status), agenda: str(c.agenda), agendaByAgent: str(c.agenda_by_agent), engagement: str(c.engagement), channel: str(c.channel), outcome: str(c.outcome) })),
    eligibility: rows(eligibilityRows).map((e) => ({ category: String(e.category), allowed: e.allowed === true, reasons: Array.isArray(e.reasons) ? (e.reasons as unknown[]).map(String) : [] })),
    plans: (planRows ?? []).map((p) => ({ id: String(p.id), name: String(p.name), version: Number(p.version), status: String(p.status), startsOn: str(p.starts_on), endsOn: str(p.ends_on) })),
    opportunities: rows(opportunityRows).map((o) => ({
      id: String(o.id), kind: String(o.kind), need: String(o.need), urgency: String(o.urgency), status: String(o.status), evidence: (Array.isArray(o.evidence) ? o.evidence : []) as { type: string; id: string }[],
      suppressedReason: str(o.suppressed_reason), salesOpportunityId: str(o.sales_opportunity_id), detectedByAgent: str(o.detected_by_agent), outcomeReason: str(o.outcome_reason),
    })),
    members,
  };
}

export type OverviewRow = {
  projectId: string; projectName: string; clientName: string; workspaceState: string; warrantyEndsOn: string | null; healthStatus: string | null; openTickets: number; slaBreached: number;
  openRecoveryPlans: number; dueCheckIns: number; renewalsInFlight: number; openOpportunities: number;
};

/** The organization-wide Customer Success overview: one row per live Phase 8 project, worst health first. */
export async function readCustomerSuccessOverview(): Promise<OverviewRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('customer_success_overview' as never, {} as never);
  if (error) unreadable('readCustomerSuccessOverview', error);
  return (Array.isArray(data) ? (data as Record<string, unknown>[]) : []).map((r) => ({
    projectId: String(r.project_id), projectName: String(r.project_name), clientName: String(r.client_name), workspaceState: String(r.workspace_state), warrantyEndsOn: str(r.warranty_ends_on),
    healthStatus: str(r.health_status), openTickets: Number(r.open_tickets ?? 0), slaBreached: Number(r.sla_breached ?? 0), openRecoveryPlans: Number(r.open_recovery_plans ?? 0),
    dueCheckIns: Number(r.due_check_ins ?? 0), renewalsInFlight: Number(r.renewals_in_flight ?? 0), openOpportunities: Number(r.open_opportunities ?? 0),
  }));
}
