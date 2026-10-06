import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The Phase 7 overview (P701 §15): the workspace state, the exact candidate, M4, the deployment plan and its gate, the deployment record, production
 * validation, incidents, the handover package, client acceptance, financial clearance, the completion gate and the Phase 8 intake - one read of the STORED
 * state. The gates are the database's own functions (deployment_gate, p7_completion_gate, p7_financial_clearance): nothing here re-derives a verdict.
 * Every read is guarded: a failed read is `unreadable`, never rendered as "nothing yet". The Phase 7 tables are not in the generated database types, so the
 * reads go through a minimal structural type rather than a hand-edit of a generated file.
 */

type Row = Record<string, unknown>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): Res & {
        order(column: string, options: { ascending: boolean }): Res & { limit(n: number): Res };
        limit(n: number): Res;
        maybeSingle(): Res;
      };
    };
  };
  rpc(fn: string, args: Record<string, unknown>): Res;
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

export type GateRow = { gate: string; satisfied: boolean; detail: string };
export type PhaseSevenOverview = {
  workspace: { id: string; state: string; completionPaused: boolean; pausedReason: string | null; commit: string; artifactSha256: string; candidateId: string; clientAcceptanceRequired: boolean; acceptanceWaiverReason: string | null } | null;
  entry: { phaseSixIntake: boolean; m4VerifiedPaid: boolean; candidateCurrent: boolean };
  plan: { id: string; version: number; status: string; targetRef: string; migrationPlan: unknown; rollbackStrategy: string | null; rollbackTarget: string | null; rollbackOwner: string | null; monitoringPlan: string | null; commit: string; artifactSha256: string } | null;
  readiness: { id: string; kind: string; name: string; status: string; owner: string | null; instruction: string | null; evidenceRef: string | null }[];
  deploymentGate: GateRow[];
  approvals: { decision: string; note: string | null; decidedAt: string; commit: string }[];
  deployments: { id: string; attempt: number; status: string; executor: string; blockerCode: string | null; commit: string; artifactSha256: string; startedAt: string | null; finishedAt: string | null; note: string | null }[];
  deploymentEvents: { deploymentId: string; kind: string; from: string | null; to: string | null; blockerCode: string | null; at: string; note: string | null }[];
  production: { validated: boolean; deploymentId: string | null };
  validationRuns: { id: string; kind: string; status: string; deploymentId: string; startedAt: string; finishedAt: string | null; checks: { key: string; truth: string; required: boolean; evidenceRef: string | null; detail: string | null }[] }[];
  incidents: { id: string; type: string; severity: string; state: string; recoveryPath: string; impact: string | null; openedAt: string; rootCause: string | null; correctiveActions: string | null; timeline: { kind: string; note: string | null; at: string }[] }[];
  rollbacks: { id: string; incidentId: string; target: string; decision: string; risk: string; executedAt: string | null; decidedAt: string }[];
  changes: { id: string; kind: string; description: string; status: string; openedAt: string }[];
  limitations: { id: string; title: string; source: string }[];
  contract: { kind: string; label: string; required: boolean; exclusionReason: string | null }[];
  handoverPackage: { id: string; version: number; status: string; commit: string; productionUrl: string | null; supportTerms: string | null; warrantyEndsOn: string | null; emergencyContacts: string | null; deliveredAt: string | null } | null;
  packageVersions: { id: string; version: number; status: string }[];
  handoverItems: { kind: string; label: string; required: boolean; status: string; artifactRef: string | null; reason: string | null }[];
  accessTransfers: { system: string; kind: string; method: string; status: string; rotated: boolean; supportRetained: boolean; evidenceRef: string | null }[];
  handoverCompleteness: GateRow[];
  handoverReviews: { version: number; decision: string; note: string | null; decidedAt: string }[];
  acceptances: { version: number; decision: string; evidenceKind: string; evidenceRef: string; client: string; recordedAt: string }[];
  feedback: { id: string; classification: string; route: string; body: string; status: string; resolution: string | null }[];
  finance: GateRow[];
  financeExceptions: { id: string; kind: string; status: string; note: string; resolution: string | null }[];
  completionGate: { gate: string; passed: boolean; detail: string; excepted: boolean; satisfied: boolean }[];
  completionExceptions: { gate: string; reason: string; risk: string; approvedAt: string }[];
  completionRecord: { id: string; completedAt: string; commit: string } | null;
  customerSuccessIntake: { id: string; createdAt: string; warrantyEndsOn: string | null } | null;
  taskGraph: { task: string; dependsOn: string[]; state: string; detail: string }[];
};

const gateRows = (v: unknown): GateRow[] => rows(v).map((g) => ({ gate: String(g.gate), satisfied: g.satisfied === true, detail: String(g.detail ?? '') }));

export async function readPhaseSevenOverview(projectId: string): Promise<PhaseSevenOverview> {
  const supabase = await createClient();
  const db = supabase.schema('projects') as unknown as Loose;

  const { data: ws, error: wsError } = await db
    .from('phase_seven')
    .select('id, state, completion_paused, paused_reason, commit_ref, artifact_sha256, candidate_id, client_acceptance_required, acceptance_waiver_reason')
    .eq('project_id', projectId)
    .maybeSingle();
  if (wsError) unreadable('readPhaseSevenOverview.workspace', wsError);
  const w = (ws as Row | null) ?? null;

  const [{ data: m4, error: m4Error }, { data: current, error: currentError }, { data: intake, error: intakeError }] = await Promise.all([
    db.rpc('m4_verified_paid', { p_project_id: projectId }),
    db.rpc('phase_seven_candidate_current', { p_project_id: projectId }),
    db.from('phase_six_handoffs').select('id').eq('project_id', projectId).maybeSingle(),
  ]);
  if (m4Error) unreadable('readPhaseSevenOverview.m4', m4Error);
  if (currentError) unreadable('readPhaseSevenOverview.candidateCurrent', currentError);
  if (intakeError) unreadable('readPhaseSevenOverview.phaseSixIntake', intakeError);
  const entry = { phaseSixIntake: Boolean(intake), m4VerifiedPaid: m4 === true, candidateCurrent: current === true };

  const empty: PhaseSevenOverview = {
    workspace: null, entry, plan: null, readiness: [], deploymentGate: [], approvals: [], deployments: [], deploymentEvents: [], production: { validated: false, deploymentId: null }, validationRuns: [], incidents: [],
    rollbacks: [], changes: [], limitations: [], contract: [], handoverPackage: null, packageVersions: [], handoverItems: [], accessTransfers: [], handoverCompleteness: [], handoverReviews: [], acceptances: [],
    feedback: [], finance: [], financeExceptions: [], completionGate: [], completionExceptions: [], completionRecord: null, customerSuccessIntake: null, taskGraph: [],
  };
  if (!w) return empty;

  const [
    { data: planRows, error: planError },
    { data: deployRows, error: deployError },
    { data: validation, error: validationError },
    { data: runRows, error: runError },
    { data: incidentRows, error: incidentError },
    { data: changeRows, error: changeError },
    { data: limitRows, error: limitError },
    { data: contractRows, error: contractError },
    { data: packageRows, error: packageError },
    { data: feedbackRows, error: feedbackError },
    { data: financeGate, error: financeGateError },
    { data: financeExRows, error: financeExError },
    { data: gateData, error: gateError },
    { data: completionExRows, error: completionExError },
    { data: recordRow, error: recordError },
    { data: handoffRow, error: handoffError },
    { data: graphRows, error: graphError },
  ] = await Promise.all([
    db.from('p7_deployment_plans').select('id, version, status, target_ref, migration_plan, rollback_strategy, rollback_target_ref, rollback_owner, monitoring_plan, commit_ref, artifact_sha256').eq('project_id', projectId).order('version', { ascending: false }).limit(1),
    db.from('p7_deployments').select('id, attempt, status, executor, blocker_code, commit_ref, artifact_sha256, started_at, finished_at, note').eq('project_id', projectId).order('created_at', { ascending: false }).limit(20),
    db.rpc('p7_production_validation', { p_project_id: projectId }),
    db.from('p7_validation_runs').select('id, kind, status, deployment_id, started_at, finished_at').eq('project_id', projectId).order('started_at', { ascending: false }).limit(20),
    db.from('p7_incidents').select('id, incident_type, severity, state, recovery_path, impact, opened_at, root_cause, corrective_actions').eq('project_id', projectId).order('opened_at', { ascending: false }).limit(20),
    db.from('p7_change_records').select('id, kind, description, status, opened_at').eq('project_id', projectId).order('opened_at', { ascending: false }).limit(20),
    db.from('p7_known_limitations').select('id, title, source').eq('project_id', projectId).order('created_at', { ascending: true }).limit(100),
    db.from('p7_contract_deliverables').select('kind, label, required, exclusion_reason').eq('project_id', projectId).order('kind', { ascending: true }).limit(20),
    db.from('p7_handover_packages').select('id, version, status, commit_ref, production_url, support_terms, warranty_ends_on, emergency_contacts, delivered_at').eq('project_id', projectId).order('version', { ascending: false }).limit(20),
    db.from('p7_handover_feedback').select('id, classification, route, body, status, resolution').eq('project_id', projectId).order('recorded_at', { ascending: false }).limit(50),
    db.rpc('p7_financial_clearance', { p_project_id: projectId }),
    db.from('p7_financial_exceptions').select('id, kind, status, note, resolution').eq('project_id', projectId).order('opened_at', { ascending: false }).limit(20),
    db.rpc('p7_completion_gate', { p_project_id: projectId }),
    db.from('p7_completion_exceptions').select('gate, reason, risk, approved_at').eq('project_id', projectId).order('approved_at', { ascending: false }).limit(10),
    db.from('p7_completion_records').select('id, completed_at, commit_ref').eq('project_id', projectId).maybeSingle(),
    db.from('phase_seven_handoffs').select('id, created_at, payload').eq('project_id', projectId).maybeSingle(),
    db.rpc('p7_task_graph', { p_project_id: projectId }),
  ]);
  if (planError) unreadable('readPhaseSevenOverview.plan', planError);
  if (deployError) unreadable('readPhaseSevenOverview.deployments', deployError);
  if (validationError) unreadable('readPhaseSevenOverview.productionValidation', validationError);
  if (runError) unreadable('readPhaseSevenOverview.validationRuns', runError);
  if (incidentError) unreadable('readPhaseSevenOverview.incidents', incidentError);
  if (changeError) unreadable('readPhaseSevenOverview.changes', changeError);
  if (limitError) unreadable('readPhaseSevenOverview.limitations', limitError);
  if (contractError) unreadable('readPhaseSevenOverview.contract', contractError);
  if (packageError) unreadable('readPhaseSevenOverview.packages', packageError);
  if (feedbackError) unreadable('readPhaseSevenOverview.feedback', feedbackError);
  if (financeGateError) unreadable('readPhaseSevenOverview.financialClearance', financeGateError);
  if (financeExError) unreadable('readPhaseSevenOverview.financialExceptions', financeExError);
  if (gateError) unreadable('readPhaseSevenOverview.completionGate', gateError);
  if (completionExError) unreadable('readPhaseSevenOverview.completionExceptions', completionExError);
  if (recordError) unreadable('readPhaseSevenOverview.completionRecord', recordError);
  if (handoffError) unreadable('readPhaseSevenOverview.customerSuccessIntake', handoffError);
  if (graphError) unreadable('readPhaseSevenOverview.taskGraph', graphError);

  // the plan, its readiness and its gate
  let plan: PhaseSevenOverview['plan'] = null;
  let readiness: PhaseSevenOverview['readiness'] = [];
  let deploymentGate: GateRow[] = [];
  let approvals: PhaseSevenOverview['approvals'] = [];
  const p = rows(planRows)[0] ?? null;
  if (p) {
    const planId = String(p.id);
    const [{ data: itemRows, error: itemError }, { data: gateRowsData, error: planGateError }, { data: approvalRows, error: approvalError }] = await Promise.all([
      db.from('p7_readiness_items').select('id, kind, name, status, owner, instruction, evidence_ref').eq('plan_id', planId).order('kind', { ascending: true }).limit(200),
      db.rpc('deployment_gate', { p_plan_id: planId }),
      db.from('p7_deployment_approvals').select('decision, note, decided_at, commit_ref').eq('plan_id', planId).order('decided_at', { ascending: false }).limit(20),
    ]);
    if (itemError) unreadable('readPhaseSevenOverview.readiness', itemError);
    if (planGateError) unreadable('readPhaseSevenOverview.deploymentGate', planGateError);
    if (approvalError) unreadable('readPhaseSevenOverview.approvals', approvalError);
    plan = {
      id: planId, version: Number(p.version), status: String(p.status), targetRef: String(p.target_ref), migrationPlan: p.migration_plan, rollbackStrategy: str(p.rollback_strategy), rollbackTarget: str(p.rollback_target_ref),
      rollbackOwner: str(p.rollback_owner), monitoringPlan: str(p.monitoring_plan), commit: String(p.commit_ref), artifactSha256: String(p.artifact_sha256),
    };
    readiness = rows(itemRows).map((i) => ({ id: String(i.id), kind: String(i.kind), name: String(i.name), status: String(i.status), owner: str(i.owner), instruction: str(i.instruction), evidenceRef: str(i.evidence_ref) }));
    deploymentGate = gateRows(gateRowsData);
    approvals = rows(approvalRows).map((a) => ({ decision: String(a.decision), note: str(a.note), decidedAt: String(a.decided_at), commit: String(a.commit_ref) }));
  }

  const deployments = rows(deployRows).map((d) => ({
    id: String(d.id), attempt: Number(d.attempt), status: String(d.status), executor: String(d.executor), blockerCode: str(d.blocker_code), commit: String(d.commit_ref), artifactSha256: String(d.artifact_sha256),
    startedAt: str(d.started_at), finishedAt: str(d.finished_at), note: str(d.note),
  }));

  // the run log of the latest deployment, the checks of the recent validation runs, the timelines of the incidents, the rollback decisions
  const latestDeploymentId = deployments[0]?.id ?? null;
  let deploymentEvents: PhaseSevenOverview['deploymentEvents'] = [];
  if (latestDeploymentId) {
    const { data: eventRows, error: eventError } = await db.from('p7_deployment_events').select('deployment_id, kind, from_status, to_status, blocker_code, created_at, note').eq('deployment_id', latestDeploymentId).order('created_at', { ascending: true }).limit(100);
    if (eventError) unreadable('readPhaseSevenOverview.deploymentEvents', eventError);
    deploymentEvents = rows(eventRows).map((e) => ({ deploymentId: String(e.deployment_id), kind: String(e.kind), from: str(e.from_status), to: str(e.to_status), blockerCode: str(e.blocker_code), at: String(e.created_at), note: str(e.note) }));
  }
  const validationRuns: PhaseSevenOverview['validationRuns'] = [];
  for (const r of rows(runRows).slice(0, 6)) {
    const { data: checkRows, error: checkError } = await db.from('p7_validation_checks').select('check_key, truth, required, evidence_ref, detail').eq('run_id', String(r.id)).order('check_key', { ascending: true }).limit(20);
    if (checkError) unreadable('readPhaseSevenOverview.validationChecks', checkError);
    validationRuns.push({
      id: String(r.id), kind: String(r.kind), status: String(r.status), deploymentId: String(r.deployment_id), startedAt: String(r.started_at), finishedAt: str(r.finished_at),
      checks: rows(checkRows).map((c) => ({ key: String(c.check_key), truth: String(c.truth), required: c.required === true, evidenceRef: str(c.evidence_ref), detail: str(c.detail) })),
    });
  }
  const incidents: PhaseSevenOverview['incidents'] = [];
  const rollbacks: PhaseSevenOverview['rollbacks'] = [];
  for (const i of rows(incidentRows).slice(0, 6)) {
    const incidentId = String(i.id);
    const [{ data: timelineRows, error: timelineError }, { data: rollbackRows, error: rollbackError }] = await Promise.all([
      db.from('p7_incident_events').select('kind, note, created_at').eq('incident_id', incidentId).order('created_at', { ascending: true }).limit(100),
      db.from('p7_rollback_decisions').select('id, incident_id, target_ref, decision, risk, executed_at, decided_at').eq('incident_id', incidentId).order('decided_at', { ascending: false }).limit(10),
    ]);
    if (timelineError) unreadable('readPhaseSevenOverview.incidentTimeline', timelineError);
    if (rollbackError) unreadable('readPhaseSevenOverview.rollbackDecisions', rollbackError);
    incidents.push({
      id: incidentId, type: String(i.incident_type), severity: String(i.severity), state: String(i.state), recoveryPath: String(i.recovery_path), impact: str(i.impact), openedAt: String(i.opened_at), rootCause: str(i.root_cause),
      correctiveActions: str(i.corrective_actions), timeline: rows(timelineRows).map((t) => ({ kind: String(t.kind), note: str(t.note), at: String(t.created_at) })),
    });
    for (const r of rows(rollbackRows)) rollbacks.push({ id: String(r.id), incidentId: String(r.incident_id), target: String(r.target_ref), decision: String(r.decision), risk: String(r.risk), executedAt: str(r.executed_at), decidedAt: String(r.decided_at) });
  }

  // the handover package that is current (the newest not superseded), its items, transfers, completeness, reviews and acceptances
  const versions = rows(packageRows).map((x) => ({ id: String(x.id), version: Number(x.version), status: String(x.status) }));
  const livePackage: Row | null = rows(packageRows).find((x) => x.status !== 'superseded') ?? rows(packageRows)[0] ?? null;
  let handoverPackage: PhaseSevenOverview['handoverPackage'] = null;
  let handoverItems: PhaseSevenOverview['handoverItems'] = [];
  let accessTransfers: PhaseSevenOverview['accessTransfers'] = [];
  let handoverCompleteness: GateRow[] = [];
  const handoverReviews: PhaseSevenOverview['handoverReviews'] = [];
  const acceptances: PhaseSevenOverview['acceptances'] = [];
  if (livePackage) {
    const packageId = String(livePackage.id);
    const [{ data: itemRows, error: itemError }, { data: transferRows, error: transferError }, { data: completeness, error: completenessError }, { data: reviewRows, error: reviewError }, { data: acceptanceRows, error: acceptanceError }] = await Promise.all([
      db.from('p7_handover_items').select('kind, label, required, status, artifact_ref, reason').eq('package_id', packageId).order('kind', { ascending: true }).limit(60),
      db.from('p7_access_transfers').select('system_name, kind, method, status, temporary_credentials_rotated, support_access_retained, evidence_ref').eq('package_id', packageId).order('system_name', { ascending: true }).limit(60),
      db.rpc('p7_handover_completeness', { p_package_id: packageId }),
      db.from('p7_handover_reviews').select('package_version, decision, note, decided_at').eq('project_id', projectId).order('decided_at', { ascending: false }).limit(20),
      db.from('p7_client_acceptances').select('package_version, decision, evidence_kind, evidence_ref, client_name, recorded_at').eq('project_id', projectId).order('recorded_at', { ascending: false }).limit(20),
    ]);
    if (itemError) unreadable('readPhaseSevenOverview.handoverItems', itemError);
    if (transferError) unreadable('readPhaseSevenOverview.accessTransfers', transferError);
    if (completenessError) unreadable('readPhaseSevenOverview.handoverCompleteness', completenessError);
    if (reviewError) unreadable('readPhaseSevenOverview.handoverReviews', reviewError);
    if (acceptanceError) unreadable('readPhaseSevenOverview.acceptances', acceptanceError);
    handoverPackage = {
      id: packageId, version: Number(livePackage.version), status: String(livePackage.status), commit: String(livePackage.commit_ref), productionUrl: str(livePackage.production_url), supportTerms: str(livePackage.support_terms),
      warrantyEndsOn: str(livePackage.warranty_ends_on), emergencyContacts: str(livePackage.emergency_contacts), deliveredAt: str(livePackage.delivered_at),
    };
    handoverItems = rows(itemRows).map((i) => ({ kind: String(i.kind), label: String(i.label), required: i.required === true, status: String(i.status), artifactRef: str(i.artifact_ref), reason: str(i.reason) }));
    accessTransfers = rows(transferRows).map((t) => ({ system: String(t.system_name), kind: String(t.kind), method: String(t.method), status: String(t.status), rotated: t.temporary_credentials_rotated === true, supportRetained: t.support_access_retained === true, evidenceRef: str(t.evidence_ref) }));
    handoverCompleteness = gateRows(completeness);
    for (const r of rows(reviewRows)) handoverReviews.push({ version: Number(r.package_version), decision: String(r.decision), note: str(r.note), decidedAt: String(r.decided_at) });
    for (const a of rows(acceptanceRows)) acceptances.push({ version: Number(a.package_version), decision: String(a.decision), evidenceKind: String(a.evidence_kind), evidenceRef: String(a.evidence_ref), client: String(a.client_name), recordedAt: String(a.recorded_at) });
  }

  const handoff = (handoffRow as Row | null) ?? null;
  const handoffPayload = (handoff?.payload as { support?: { warrantyEndsOn?: string | null } } | null) ?? null;
  const record = (recordRow as Row | null) ?? null;
  return {
    workspace: {
      id: String(w.id), state: String(w.state), completionPaused: w.completion_paused === true, pausedReason: str(w.paused_reason), commit: String(w.commit_ref), artifactSha256: String(w.artifact_sha256), candidateId: String(w.candidate_id),
      clientAcceptanceRequired: w.client_acceptance_required !== false, acceptanceWaiverReason: str(w.acceptance_waiver_reason),
    },
    entry, plan, readiness, deploymentGate, approvals, deployments, deploymentEvents,
    production: { validated: rows(validation).length > 0, deploymentId: str(rows(validation)[0]?.deployment_id) },
    validationRuns, incidents, rollbacks,
    changes: rows(changeRows).map((c) => ({ id: String(c.id), kind: String(c.kind), description: String(c.description), status: String(c.status), openedAt: String(c.opened_at) })),
    limitations: rows(limitRows).map((l) => ({ id: String(l.id), title: String(l.title), source: String(l.source) })),
    contract: rows(contractRows).map((c) => ({ kind: String(c.kind), label: String(c.label), required: c.required === true, exclusionReason: str(c.exclusion_reason) })),
    handoverPackage, packageVersions: versions, handoverItems, accessTransfers, handoverCompleteness, handoverReviews, acceptances,
    feedback: rows(feedbackRows).map((f) => ({ id: String(f.id), classification: String(f.classification), route: String(f.route), body: String(f.body), status: String(f.status), resolution: str(f.resolution) })),
    finance: gateRows(financeGate),
    financeExceptions: rows(financeExRows).map((e) => ({ id: String(e.id), kind: String(e.kind), status: String(e.status), note: String(e.note), resolution: str(e.resolution) })),
    completionGate: rows(gateData).map((g) => ({ gate: String(g.gate), passed: g.passed === true, detail: String(g.detail ?? ''), excepted: g.excepted === true, satisfied: g.satisfied === true })),
    completionExceptions: rows(completionExRows).map((e) => ({ gate: String(e.gate), reason: String(e.reason), risk: String(e.risk), approvedAt: String(e.approved_at) })),
    completionRecord: record ? { id: String(record.id), completedAt: String(record.completed_at), commit: String(record.commit_ref) } : null,
    customerSuccessIntake: handoff ? { id: String(handoff.id), createdAt: String(handoff.created_at), warrantyEndsOn: handoffPayload?.support?.warrantyEndsOn ?? null } : null,
    taskGraph: rows(graphRows).map((t) => ({ task: String(t.task), dependsOn: Array.isArray(t.depends_on) ? (t.depends_on as string[]) : [], state: String(t.state), detail: String(t.detail ?? '') })),
  };
}
