import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

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

/** The plan whose approval still holds for the current candidate (the door answers; a failed answer is thrown, so the runner retries rather than concluding "none"). */
async function liveApprovedPlan(projects: Loose, planIds: string[]): Promise<string | null> {
  for (const id of planIds) {
    const { data, error } = await projects.rpc('p7_deployment_approved', { p_plan_id: id });
    if (error) throw new Error(`the approval could not be read: ${error.message}`);
    if (data === true) return id;
  }
  return null;
}
