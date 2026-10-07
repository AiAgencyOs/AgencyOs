import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { buildPhaseSevenEnvelope, decidePhaseSevenRoute, phaseSevenPolicyVersion, taskTypeForEvent, validatePhaseSevenEnvelope } from '@/modules/orchestrator/phase-seven-route';

import { resolveDeploymentExecutor } from './deployment-executor';
import type { HandlerResult, UnlockJob } from './handlers';

/**
 * Phase 7 job handlers (P701 §14, P704 §13). They run under the service role behind the cron-authenticated runner, so every read scopes by the JOB's
 * organization by hand, and the event payload is never trusted for anything but a subject id. The decisions are the DATABASE doors', not these handlers'.
 */

type Admin = ReturnType<typeof createAdminClient>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  from(table: string): { select(columns: string): { eq(column: string, value: string): { eq(column: string, value: string): { maybeSingle(): Res; limit(n: number): Res } } } };
  rpc(fn: string, args: Record<string, unknown>): Res;
};
type Row = Record<string, unknown>;
const firstRow = (v: unknown): Row | undefined => (Array.isArray(v) ? (v[0] as Row | undefined) : (v as Row | undefined)) ?? undefined;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * `project.phase_six_completed` / `project.m4_payment_verified` -> create the Phase 7 workspace, or make it READY (P701 §2, §5).
 *
 * The door decides: it is WAITING_M4_VERIFICATION until M4 is Admin-verified paid in full, READY only while the exact Phase 6 candidate is still current,
 * and a replay of either event is `already_started`, never a second Phase7Ready.
 */
export async function handleOpenPhaseSeven(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const projectId = job.payload?.subjectId ?? null;
  if (!projectId) return { status: 'failed', permanent: true, detail: 'the event named no project' };
  const projects = admin.schema('projects') as unknown as Loose;
  const { data: found, error: findError } = await projects.from('projects').select('id').eq('id', projectId).eq('organization_id', job.organization_id).maybeSingle();
  if (findError) return { status: 'failed', permanent: false, detail: `the project could not be read: ${findError.message}` };
  if (!found) return { status: 'succeeded', outcome: 'gone', detail: 'the project is not in this organization' };
  const { data, error } = await projects.rpc('open_phase_seven', { p_project_id: projectId });
  if (error) return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  const outcome = str(firstRow(data)?.outcome) ?? 'no answer';
  switch (outcome) {
    case 'ready':
      return { status: 'succeeded', outcome, detail: 'Phase 7 is READY: M4 is verified and the exact Phase 6 candidate is current.' };
    case 'waiting_m4_verification':
      return { status: 'succeeded', outcome, detail: 'Phase 7 exists and is waiting for the M4 payment to be verified.' };
    case 'candidate_not_current':
      return { status: 'succeeded', outcome, detail: 'The Phase 6 approved candidate is no longer current: a new governed candidate is needed.' };
    case 'already_started':
      return { status: 'succeeded', outcome, detail: 'Phase 7 had already started for this project.' };
    case 'phase_six_incomplete':
      return { status: 'succeeded', outcome: 'not_ready', detail: 'Phase 6 has not completed (no intake exists).' };
    case 'unknown_project':
      return { status: 'failed', permanent: true, detail: 'the project no longer exists.' };
    default:
      return { status: 'failed', permanent: false, detail: `the door answered ${outcome}` };
  }
}

/**
 * `project.deployment_approved` -> record the deployment of the approved plan; `project.deployment_incident_closed` (rollback path) -> record the redeploy.
 *
 * THE EXECUTOR IS NOT CONFIGURED, so after the deployment is RECORDED as approved the executor's answer is stored as an honest blocker. This handler never
 * starts, succeeds, fails or validates a deployment itself, and never reports a success the executor did not produce.
 */
export async function handleRunDeployment(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const subjectId = envelope.subjectId ?? null;
  if (!subjectId) return { status: 'failed', permanent: true, detail: 'the event named no subject' };
  const projects = admin.schema('projects') as unknown as Loose;

  let planId: string;
  let idempotencyKey: string;
  if (envelope.eventType === 'project.deployment_incident_closed') {
    const { data: incident, error: incidentError } = await projects.from('p7_incidents').select('id, project_id, recovery_path').eq('id', subjectId).eq('organization_id', job.organization_id).maybeSingle();
    if (incidentError) return { status: 'failed', permanent: false, detail: `the incident could not be read: ${incidentError.message}` };
    const row = firstRow(incident);
    if (!row) return { status: 'succeeded', outcome: 'gone', detail: 'the incident is not in this organization' };
    if (row.recovery_path !== 'rollback') return { status: 'succeeded', outcome: 'not_a_rollback', detail: 'only a rolled-back deployment is redeployed from here' };
    const { data: plans, error: plansError } = await projects.from('p7_deployment_plans').select('id').eq('project_id', String(row.project_id)).eq('organization_id', job.organization_id).limit(50);
    if (plansError) return { status: 'failed', permanent: false, detail: `the plans could not be read: ${plansError.message}` };
    const live = await liveApprovedPlan(projects, Array.isArray(plans) ? (plans as Row[]).map((p) => String(p.id)) : []);
    if (!live) return { status: 'succeeded', outcome: 'no_approved_plan', detail: 'there is no approved plan to redeploy: a new plan and approval are needed' };
    planId = live;
    idempotencyKey = `redeploy:${subjectId}`;
  } else {
    planId = subjectId;
    idempotencyKey = `approval:${subjectId}`;
  }

  const { data: plan, error: planError } = await projects.from('p7_deployment_plans').select('id, project_id, commit_ref, artifact_sha256, environment').eq('id', planId).eq('organization_id', job.organization_id).maybeSingle();
  if (planError) return { status: 'failed', permanent: false, detail: `the plan could not be read: ${planError.message}` };
  const planRow = firstRow(plan);
  if (!planRow) return { status: 'succeeded', outcome: 'gone', detail: 'the plan is not in this organization' };

  const { data, error } = await projects.rpc('request_deployment', { p_plan_id: planId, p_idempotency_key: idempotencyKey });
  if (error) return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  const answer = firstRow(data);
  const outcome = str(answer?.outcome) ?? 'no answer';
  const deploymentId = str(answer?.deployment_id);
  if (outcome === 'already_requested' || outcome === 'deployment_in_progress' || outcome === 'already_deployed') {
    return { status: 'succeeded', outcome, detail: 'the deployment was already recorded: nothing new was started' };
  }
  if (outcome === 'not_approved' || outcome === 'incident_containment') {
    return { status: 'succeeded', outcome, detail: `the door refused: ${outcome === 'not_approved' ? 'the approval is no longer valid for the current candidate' : 'an open critical incident stops deploy actions'}` };
  }
  if (outcome !== 'requested' || !deploymentId) return { status: 'failed', permanent: false, detail: `the door answered ${outcome}` };

  const executor = resolveDeploymentExecutor();
  const result = await executor.execute({
    deploymentId,
    planId,
    projectId: String(planRow.project_id),
    commitRef: String(planRow.commit_ref),
    artifactSha256: String(planRow.artifact_sha256),
    environment: 'production',
  });
  if (result.status === 'blocked') {
    const { data: blockerData, error: blockerError } = await projects.rpc('record_deployment_blocker', { p_deployment_id: deploymentId, p_code: result.code, p_detail: result.detail });
    if (blockerError) return { status: 'failed', permanent: false, detail: `the blocker could not be recorded: ${blockerError.message}` };
    const blocked = str(firstRow(blockerData)?.outcome) ?? 'no answer';
    return { status: 'succeeded', outcome: 'blocked_no_executor', detail: `the deployment is recorded as approved and NOT started: ${result.code} (door: ${blocked}). Nothing was deployed.` };
  }
  return { status: 'succeeded', outcome: 'executor_accepted', detail: 'the executor accepted the deployment and reports its own progress through the runner door.' };
}

/**
 * `project.completed` -> fill Phase 8's intake from the frozen Phase 7 handoff (docs/phase-8a-manual-actions.md M-6).
 *
 * The door is `projects.fill_phase_eight_intake` (service role): it reads the project's frozen `phase_seven_handoffs` row (and falls back to the legacy completion
 * record for a project that never entered the Phase 7 pipeline), evaluates the eight start gates and writes ONE intake row per project, refreshing it until Phase 8
 * starts. It starts nothing: a person defines the warranty window and starts Phase 8. A replay is safe by construction (one row per project; `already_started`).
 */
export async function handleFillPhaseEightIntake(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const projectId = job.payload?.subjectId ?? null;
  if (!projectId) return { status: 'failed', permanent: true, detail: 'the event named no project' };
  const projects = admin.schema('projects') as unknown as Loose;
  const { data: found, error: findError } = await projects.from('projects').select('id').eq('id', projectId).eq('organization_id', job.organization_id).maybeSingle();
  if (findError) return { status: 'failed', permanent: false, detail: `the project could not be read: ${findError.message}` };
  if (!found) return { status: 'succeeded', outcome: 'gone', detail: 'the project is not in this organization' };
  // the organization is the JOB's, never the payload's
  const { data, error } = await projects.rpc('fill_phase_eight_intake', { p_organization_id: job.organization_id, p_project_id: projectId });
  if (error) return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  const outcome = str(firstRow(data)?.outcome) ?? 'no answer';
  switch (outcome) {
    case 'ready':
      return { status: 'succeeded', outcome, detail: 'the Phase 8 intake is READY from the completion facts; a person defines the warranty window and starts Phase 8.' };
    case 'incomplete':
      return { status: 'succeeded', outcome, detail: 'the Phase 8 intake exists with named blockers; a person resolves or waives them (the intake refreshes until Phase 8 starts).' };
    case 'already_started':
      return { status: 'succeeded', outcome, detail: 'Phase 8 had already started: its intake is frozen.' };
    case 'not_completed':
      return { status: 'succeeded', outcome, detail: 'the project is not completed: there is no intake to build yet.' };
    case 'unknown_project':
      return { status: 'failed', permanent: true, detail: 'the project no longer exists.' };
    default:
      return { status: 'failed', permanent: false, detail: `the door answered ${outcome}` };
  }
}

type AiLoose = { from(table: string): { select(columns: string): { in(column: string, values: readonly string[]): Res } } };

/**
 * `project.deployment_approved` / `project.deployment_failed` / `project.production_validation_failed` -> the Orchestrator's Phase 7 routing decision
 * (P703), RECORDED. The decision is the pure function `decidePhaseSevenRoute`; the facts (is the agent enabled, does the plan's approval still hold, which
 * state the workspace is in) are read here under the job's organization. The database door refuses a decision the rules forbid.
 *
 * Every Phase 7 agent is disabled and holds no tool, so today the recorded outcome is HELD with the reason stated. This handler never starts a deployment,
 * validates production, approves or closes anything: it records where the work WOULD go and why it cannot go there yet.
 */
export async function handleRoutePhaseSevenTask(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const subjectId = envelope.subjectId ?? null;
  const taskType = envelope.eventType ? taskTypeForEvent(envelope.eventType) : null;
  if (!subjectId || !taskType) return { status: 'failed', permanent: true, detail: 'the event names no routable Phase 7 task' };
  const projects = admin.schema('projects') as unknown as Loose;

  // the subject is a plan (an approval) or a deployment (a failure); the project, commit and artifact come from the ROW, never the event payload
  const table = taskType === 'deployment_execution' ? 'p7_deployment_plans' : 'p7_deployments';
  const { data: subject, error: subjectError } = await projects.from(table).select('id, project_id, commit_ref, artifact_sha256').eq('id', subjectId).eq('organization_id', job.organization_id).maybeSingle();
  if (subjectError) return { status: 'failed', permanent: false, detail: `the subject could not be read: ${subjectError.message}` };
  const row = firstRow(subject);
  if (!row) return { status: 'succeeded', outcome: 'gone', detail: 'the subject is not in this organization' };
  const projectId = String(row.project_id);

  const { data: workspace, error: workspaceError } = await projects.from('phase_seven').select('state').eq('project_id', projectId).eq('organization_id', job.organization_id).maybeSingle();
  if (workspaceError) return { status: 'failed', permanent: false, detail: `the workspace could not be read: ${workspaceError.message}` };

  const { data: agents, error: agentsError } = await (admin.schema('ai') as unknown as AiLoose).from('agents').select('key, enabled').in('key', ['deployment_agent', 'release_qa', 'incident_recovery']);
  if (agentsError) return { status: 'failed', permanent: false, detail: `the agents could not be read: ${agentsError.message}` };
  const enabled = new Map<string, boolean>((Array.isArray(agents) ? (agents as Row[]) : []).map((a) => [String(a.key), a.enabled === true]));

  let planApproved: boolean | null = null;
  if (taskType === 'deployment_execution') {
    const { data: approved, error: approvedError } = await projects.rpc('p7_deployment_approved', { p_plan_id: subjectId });
    if (approvedError) return { status: 'failed', permanent: false, detail: `the approval could not be read: ${approvedError.message}` };
    planApproved = approved === true;
  }

  const route = decidePhaseSevenRoute(taskType, { enabled, workspaceState: str(firstRow(workspace)?.state), planApproved });
  const built = buildPhaseSevenEnvelope({
    taskType,
    organizationId: job.organization_id,
    projectId,
    subjectId,
    planId: taskType === 'deployment_execution' ? subjectId : null,
    candidate: { commitRef: str(row.commit_ref), artifactSha256: str(row.artifact_sha256) },
    routingReason: route.reason,
  });
  if (route.outcome === 'routed') {
    const problems = validatePhaseSevenEnvelope(built);
    if (problems.length > 0) return { status: 'failed', permanent: true, detail: `the envelope was rejected, not repaired: ${problems.join('; ')}` };
  }

  const { data, error } = await projects.rpc('record_phase_seven_routing', {
    p_organization_id: job.organization_id,
    p_project_id: projectId,
    p_task_type: taskType,
    p_decision_key: `${envelope.eventType}:${subjectId}`,
    p_outcome: route.outcome,
    p_code: route.code,
    p_to_agent: route.toAgent,
    p_reason: route.reason,
    p_candidates: route.candidates,
    p_envelope: route.outcome === 'held' || route.outcome === 'routed' ? built : null,
    p_subject_id: subjectId,
    p_policy_version: phaseSevenPolicyVersion(),
    p_correlation_id: job.correlation_id,
  });
  if (error) return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  const outcome = str(firstRow(data)?.outcome) ?? 'no answer';
  if (outcome === 'recorded' || outcome === 'already_recorded') {
    return { status: 'succeeded', outcome: `${route.outcome}:${route.code}`, detail: `${route.reason} (${outcome === 'recorded' ? 'recorded' : 'already recorded'})` };
  }
  // the database and the pure rule disagree: that is a defect to surface, never to retry into a pass
  return { status: 'failed', permanent: true, detail: `the database refused the decision (${outcome}): the rule and the door disagree` };
}

/**
 * `message.received` -> open a support ticket from a client's support message (Phase 8A, docs/phase-8a-manual-actions.md M-5).
 *
 * The door is `projects.open_support_ticket_from_message` (service role): it RE-READS the message row under the JOB's organization (the event payload is only a
 * subject id) and opens a ticket only for a client's message in a PROJECT conversation of a project whose Phase 8 workspace is ACTIVE, labelled
 * `support_request`. Anything else opens nothing and says why. This handler never replies, sends or classifies: it opens a ticket a person triages.
 * An intent label that has not arrived yet is not a failure: the cron sweep (`sweep_message_support_tickets`) opens the ticket if the label arrives within three days.
 */
export async function handleOpenSupportTicketFromMessage(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const messageId = job.payload?.subjectId ?? null;
  if (!messageId) return { status: 'failed', permanent: true, detail: 'the event named no message' };
  const projects = admin.schema('projects') as unknown as Loose;
  const { data, error } = await projects.rpc('open_support_ticket_from_message', { p_organization_id: job.organization_id, p_message_id: messageId });
  if (error) return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  const outcome = str(firstRow(data)?.outcome) ?? 'no answer';
  switch (outcome) {
    case 'opened':
      return { status: 'succeeded', outcome, detail: 'a support ticket was opened from the client message; a person classifies it. Nothing was sent.' };
    case 'duplicate':
      return { status: 'succeeded', outcome, detail: 'the message already has its ticket: nothing new was opened' };
    case 'intent_pending':
      return { status: 'succeeded', outcome, detail: 'the message has no intent label yet: nothing was opened (the sweep opens a ticket if a support_request label arrives)' };
    case 'no_intent_label':
    case 'not_a_support_request':
    case 'not_a_client_message':
    case 'not_a_project_conversation':
    case 'no_phase_eight':
    case 'workspace_not_active':
    case 'not_found':
      return { status: 'succeeded', outcome, detail: `no ticket was opened (${outcome.replaceAll('_', ' ')})` };
    default:
      return { status: 'failed', permanent: false, detail: `the door answered ${outcome}` };
  }
}

/**
 * `project.production_validated` -> create the DRAFT handover package from the contract checklist when none exists (P707 §13).
 *
 * The door is `projects.create_draft_handover_package_for_validated` (service role): the workspace is read by id under the JOB's organization, production
 * validation is re-read from the evidence, and a package is born a draft (version 1, one item per contract deliverable). It never submits, approves or delivers.
 * Without a contract checklist it creates nothing (the catch-up sweep creates the draft once a person has recorded one).
 */
export async function handleCreateDraftHandoverPackage(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const phaseSevenId = job.payload?.subjectId ?? null;
  if (!phaseSevenId) return { status: 'failed', permanent: true, detail: 'the event named no workspace' };
  const projects = admin.schema('projects') as unknown as Loose;
  const { data, error } = await projects.rpc('create_draft_handover_package_for_validated', { p_organization_id: job.organization_id, p_phase_seven_id: phaseSevenId });
  if (error) return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  const outcome = str(firstRow(data)?.outcome) ?? 'no answer';
  switch (outcome) {
    case 'created':
      return { status: 'succeeded', outcome, detail: 'a DRAFT handover package was created from the contract checklist; a person completes, submits and delivers it.' };
    case 'already_exists':
      return { status: 'succeeded', outcome, detail: 'a handover package already exists: nothing new was created' };
    case 'contract_deliverables_missing':
      return { status: 'succeeded', outcome, detail: 'no contract checklist is recorded: no draft was created (a person records the deliverables; the sweep then creates it)' };
    case 'production_not_validated':
    case 'm4_not_verified':
      return { status: 'succeeded', outcome, detail: `no draft was created (${outcome.replaceAll('_', ' ')})` };
    case 'not_found':
      return { status: 'succeeded', outcome: 'gone', detail: 'the workspace is not in this organization' };
    default:
      return { status: 'failed', permanent: false, detail: `the door answered ${outcome}` };
  }
}

/** The plan whose approval still holds for the current candidate (the door answers; a failed answer is thrown, so the runner retries rather than concluding "none"). */
async function liveApprovedPlan(projects: Loose, planIds: string[]): Promise<string | null> {
  for (const id of planIds) {
    const { data, error } = await projects.rpc('p7_deployment_approved', { p_plan_id: id });
    if (error) throw new Error(`the approval could not be read: ${error.message}`);
    if (data === true) return id;
  }
  return null;
}
