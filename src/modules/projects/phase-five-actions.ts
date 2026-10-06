'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { handleRouteDevelopmentPlan } from '@/modules/orchestrator/handlers';
import { notConfiguredExecutor, runBuild, type Executor } from './build-runner';
import { runIntegrationCheck, type HttpClient } from './integration-check';

/**
 * Phase 5 Admin actions - one thin server action per database door the Phase 5 overview describes. NOTHING here decides: each action asks a
 * door (which checks the role, the state, the independence rules and the gates under its own lock) and reports the door's own answer in plain
 * words. A client-side copy of any rule would disagree with the database the moment state moved elsewhere.
 */

const WORDS: Record<string, string> = {
  recorded: 'Recorded.',
  decided: 'Decision recorded.',
  submitted: 'Shared with the client for approval.',
  defect_raised: 'Raised as a defect against this build.',
  change_request_raised: 'Raised as a Change Request: it is not free work and is not a defect.',
  revision_routed: 'Routed to the controlled revision flow.',
  clarification_needed: 'Marked for clarification before anything is changed.',
  already_classified: 'Already classified; a routed piece of feedback is not re-labelled.',
  self_review: 'You produced this build, so you cannot review or pass it. Someone else must.',
  not_qa_passed: 'The build has not passed QA yet; the Admin approves what QA passed.',
  not_admin_approved: 'The Admin has not approved this build yet.',
  not_qa_passed_gate: 'The build has not passed QA.',
  no_commit: 'This build names no exact commit, so it cannot be reviewed or shared.',
  no_build_run: 'No successful build run is recorded for this exact commit.',
  review_missing: 'There is no independent code review of this commit yet.',
  review_stale: 'The code review is of an older commit; review the current one.',
  review_changes_required: 'The code review asked for changes.',
  review_blocked: 'The code review blocked this build.',
  review_needs_second: 'A reviewer who changed the code needs a second independent reviewer.',
  blocked: 'An unverified blocker or major defect still blocks this build.',
  blocking_finding: 'A review carrying a critical or high finding cannot pass.',
  not_authorized: 'You do not have permission to do this.',
  not_shared: 'The client has not been given this build yet.',
  not_found: 'That record was not found.',
  not_reviewable: 'This build is no longer open for review.',
  wrong_kind: 'That is not a development build.',
  no_policy: 'No approval policy is configured for client approval of builds.',
  started: 'Phase 5 started and its baseline locked.',
  already_started: 'Phase 5 had already started.',
  phase_four_incomplete: 'Phase 4 is not complete yet.',
  no_locked_ui: 'There is no locked UI version to build against.',
  no_approved_prototype: 'There is no client-approved prototype build.',
  no_active_scope: 'There is no active scope version.',
  m2_not_verified: 'The M2 payment is not verified paid in full.',
  bad_commit: 'A base commit is 7 to 40 lowercase hex characters.',
  already_recorded: 'The baseline already has its base commit; it is never replaced.',
  repository_not_on_project: 'That repository is not linked to this project.',
  not_found_or_closed: 'That escalation is not open.',
  bad_url: 'The check URL must be an https address.',
  bad_credential_name: 'A secret is named in capitals and underscores (for example STRIPE_TEST_KEY); never paste the value.',
  pass_needs_checks_and_evidence: 'A smoke PASS names the checks that ran and an https evidence link.',
  bad_result: 'Choose a smoke result.',
  created: 'Plan created.',
  planned: 'Task planned.',
  approved: 'Plan approved.',
  already_approved: 'That plan is already approved.',
  not_approvable: 'The plan still has problems; they are listed above.',
  plan_not_draft: 'An approved plan is not edited: a change is a new plan version.',
  task_started: 'That task has already started.',
  no_baseline: 'There is no locked development baseline yet.',
  registered: 'Integration registered (unknown until an adapter verifies it).',
  already_registered: 'That integration is already registered.',
  set: 'Recorded.',
  only_an_adapter_verifies: 'A person cannot mark an integration verified; only an adapter result with evidence can.',
  reason_required: 'Say why: NOT_REQUIRED and blocked both need a reason.',
  quarantined: 'Quarantined with an owner and an expiry.',
  resolved: 'Resolved.',
  seen_again: 'Counted again.',
  expiry_required_within_30_days: 'A quarantine needs an expiry within 30 days.',
  resolution_required: 'Say what was fixed.',
  refused: 'Refused: a document cannot claim more than its evidence (an integration is implemented only when verified; no secret values).',
  linked: 'Linked: this run is now evidence for the task (a failing run does not count as coverage).',
  already_linked: 'That run is already linked to the task.',
  wrong_project: 'That run belongs to a different project.',
  derived: 'Documentation re-derived from the current records.',
  no_build: 'There is no development build to derive documentation from yet.',
  invalid: 'Not recorded: an implemented document must name the evidence it came from.',
};

type Door = { outcome?: string | null };
const first = (data: unknown): Door => ((Array.isArray(data) ? data[0] : data) ?? {}) as Door;

async function gate(): Promise<FormState | null> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this project.' };
  return null;
}

async function run(
  projectId: string,
  rpc: string,
  args: Record<string, unknown>,
  successOutcomes: readonly string[],
): Promise<FormState> {
  const refused = await gate();
  if (refused) return refused;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc(rpc as never, args as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const outcome = String(first(data).outcome ?? 'no answer');
  const message = WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;
  if (!successOutcomes.includes(outcome)) return { status: 'error', message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message };
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();

export async function recordBuildQaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'record_build_qa_verdict', {
    p_deliverable_id: text(formData, 'deliverableId'),
    p_outcome: text(formData, 'outcome'),
    p_note: text(formData, 'note') || null,
    p_evidence_url: text(formData, 'evidenceUrl') || null,
  }, ['recorded']);
}

/** Findings are typed one per line as `severity: title` (critical, high, medium, low). */
function parseFindings(raw: string): { severity: string; title: string }[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(critical|high|medium|low)\s*:\s*(.+)$/i.exec(line);
      return m ? { severity: m[1]!.toLowerCase(), title: m[2]!.trim() } : { severity: 'medium', title: line };
    });
}

export async function recordCodeReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'record_code_review', {
    p_deliverable_id: text(formData, 'deliverableId'),
    p_verdict: text(formData, 'verdict'),
    p_findings: parseFindings(text(formData, 'findings')),
    p_reviewer_changed_code: formData.get('changedCode') === 'on',
    p_note: text(formData, 'note') || null,
  }, ['recorded']);
}

export async function decideBuildAdminAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'decide_build_admin', {
    p_deliverable_id: text(formData, 'deliverableId'),
    p_decision: text(formData, 'decision'),
    p_note: text(formData, 'note') || null,
  }, ['decided']);
}

export async function shareBuildWithClientAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const refused = await gate();
  if (refused) return refused;
  const projectId = text(formData, 'projectId');
  const context = await requireInternal();
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('submit_deliverable', {
    p_deliverable_id: text(formData, 'deliverableId'),
    p_requested_by: context.userId,
    p_summary: undefined,
  } as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const outcome = String(first(data).outcome ?? 'no answer');
  if (outcome !== 'submitted') return { status: 'error', message: WORDS[outcome] ?? `Not shared: ${outcome.replace(/_/g, ' ')}.` };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: WORDS.submitted! };
}

export async function recordBuildFeedbackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'record_build_feedback', {
    p_deliverable_id: text(formData, 'deliverableId'),
    p_client_words: text(formData, 'clientWords'),
    p_evidence_ref: text(formData, 'evidenceRef') || null,
  }, ['recorded']);
}

export async function classifyBuildFeedbackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'classify_build_feedback', {
    p_feedback_id: text(formData, 'feedbackId'),
    p_classification: text(formData, 'classification'),
  }, ['defect_raised', 'change_request_raised', 'revision_routed', 'clarification_needed']);
}


export async function createDevelopmentPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'create_development_plan', {
    p_project_id: text(formData, 'projectId'),
    p_summary: text(formData, 'summary'),
    p_risks: text(formData, 'risks') || null,
    p_test_strategy: text(formData, 'testStrategy') || null,
    p_rollback_plan: text(formData, 'rollbackPlan') || null,
  }, ['created']);
}

export async function planTaskAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'plan_task', {
    p_task_id: text(formData, 'taskId'),
    p_plan_id: text(formData, 'planId'),
    p_acceptance_criteria: text(formData, 'acceptanceCriteria'),
    p_required_capability: text(formData, 'capability'),
    p_risk_level: text(formData, 'riskLevel') || 'medium',
    p_affected_paths: text(formData, 'paths').split(/[\s,]+/).filter(Boolean),
  }, ['planned']);
}

export async function approveDevelopmentPlanAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'approve_development_plan', { p_plan_id: text(formData, 'planId') }, ['approved', 'already_approved']);
}

export async function registerIntegrationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'register_integration', {
    p_project_id: text(formData, 'projectId'),
    p_kind: text(formData, 'kind'),
    p_name: text(formData, 'name'),
    p_is_mock: formData.get('isMock') === 'on',
  }, ['registered', 'already_registered']);
}

export async function setIntegrationStateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'set_integration_state', {
    p_connection_id: text(formData, 'connectionId'),
    p_health: text(formData, 'health'),
    p_note: text(formData, 'note') || null,
  }, ['set']);
}

export async function setSpecialistStateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'set_phase_five_agent_state', {
    p_project_id: text(formData, 'projectId'),
    p_agent_key: text(formData, 'agentKey'),
    p_state: text(formData, 'state'),
    p_reason: text(formData, 'reason') || null,
  }, ['set']);
}

export async function recordDocumentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'record_technical_document', {
    p_project_id: text(formData, 'projectId'),
    p_kind: text(formData, 'kind'),
    p_title: text(formData, 'title'),
    p_status: text(formData, 'status'),
    p_evidence_ref: text(formData, 'evidenceRef') || null,
    p_integration_id: text(formData, 'integrationId') || null,
    p_body: text(formData, 'body') || null,
  }, ['recorded']);
}

/** The flaky-test doors live in the `qa` schema. */
async function runQa(projectId: string, rpc: string, args: Record<string, unknown>, success: readonly string[]): Promise<FormState> {
  const refused = await gate();
  if (refused) return refused;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc(rpc as never, args as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const outcome = String(first(data).outcome ?? 'no answer');
  const message = WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;
  if (!success.includes(outcome)) return { status: 'error', message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message };
}

export async function recordFlakyTestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return runQa(text(formData, 'projectId'), 'record_flaky_test', {
    p_project_id: text(formData, 'projectId'),
    p_test_key: text(formData, 'testKey'),
    p_suite: text(formData, 'suite') || null,
    p_suspected_cause: text(formData, 'cause') || null,
  }, ['recorded', 'seen_again']);
}

export async function resolveFlakyTestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const rawDays = text(formData, 'days') || '7';
  const days = Number(rawDays);
  if (text(formData, 'action') === 'quarantine' && !(Number.isInteger(days) && days >= 1 && days <= 30)) {
    return { status: 'error', message: 'A quarantine lasts a whole number of days from 1 to 30.' };
  }
  return runQa(text(formData, 'projectId'), 'resolve_flaky_test', {
    p_flaky_id: text(formData, 'flakyId'),
    p_action: text(formData, 'action'),
    p_resolution: text(formData, 'resolution') || null,
    p_expires_at: text(formData, 'action') === 'quarantine' ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
  }, ['quarantined', 'resolved']);
}


export async function linkTaskTestRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'link_task_test_run', {
    p_task_id: text(formData, 'taskId'),
    p_test_run_id: text(formData, 'testRunId'),
  }, ['linked', 'already_linked']);
}

export async function deriveDocumentsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'derive_phase_five_documents', { p_project_id: text(formData, 'projectId') }, ['derived']);
}


/** The one-shot trigger (the verified-payment event) is not the only way in: a person may ask the door to start Phase 5. The door re-checks every condition. */
export async function startPhaseFiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await run(text(formData, 'projectId'), 'start_phase_five', { p_project_id: text(formData, 'projectId') }, ['started', 'already_started']);
  return result;
}


/** Name the repository and base commit the locked baseline was cut from: recorded once, never edited. */
export async function recordBaselineCommitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'record_baseline_commit', {
    p_project_id: text(formData, 'projectId'),
    p_repository_id: text(formData, 'repositoryId'),
    p_base_commit: text(formData, 'baseCommit').toLowerCase(),
  }, ['recorded']);
}


export async function resolveEscalationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'resolve_escalation', { p_escalation_id: text(formData, 'escalationId'), p_resolution: text(formData, 'resolution') }, ['resolved']);
}


/** Where a check calls, and the NAME of the secret it authenticates with. Changing either drops VERIFIED. */
export async function setIntegrationCheckTargetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ref = text(formData, 'credentialRef');
  return run(text(formData, 'projectId'), 'set_integration_check_target', {
    p_connection_id: text(formData, 'connectionId'),
    p_check_url: text(formData, 'checkUrl'),
    p_credential_ref: ref === '' ? null : ref,
  }, ['set']);
}

const fetchHttp: HttpClient = async ({ url, headers, timeoutMs }) => {
  const res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  const retryAfter = Number(res.headers.get('retry-after'));
  return { status: res.status, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
};

/**
 * Run the adapter check for one integration NOW. Only the adapter (this, with the service role) can write VERIFIED, and only on a 2xx from the
 * declared URL. A missing secret verifies nothing and says which secret name is unset.
 */
export async function runIntegrationCheckAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const refused = await gate();
  if (refused) return refused;
  const projectId = text(formData, 'projectId');
  const connectionId = text(formData, 'connectionId');
  const supabase = await createClient();
  // read through the caller's own session: a connection of another organization is simply not found
  const { data: row, error } = await supabase
    .schema('projects')
    .from('integration_connections')
    .select('id, kind, health, is_mock, check_url, credential_ref')
    .eq('id', connectionId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) return { status: 'error', message: 'The integration could not be read; nothing was checked.' };
  if (!row) return { status: 'error', message: 'That integration was not found.' };
  const admin = createAdminClient();
  const outcome = await runIntegrationCheck({
    connection: { id: row.id, checkUrl: row.check_url, credentialRef: row.credential_ref, isMock: row.is_mock === true, health: row.health, kind: row.kind },
    adapter: 'http_health',
    http: fetchHttp,
    env: process.env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    record: async ({ ok, evidence }) => {
      const { data } = await admin.schema('projects').rpc('record_integration_check', { p_connection_id: connectionId, p_adapter: 'http_health', p_ok: ok, p_evidence: evidence });
      return String(first(data).outcome ?? 'no answer');
    },
    note: async (checkClass) => {
      await (admin.schema('projects') as unknown as { rpc(name: string, args: unknown): PromiseLike<unknown> }).rpc('note_integration_check', { p_connection_id: connectionId, p_class: checkClass });
    },
  });
  revalidatePath(`/projects/${projectId}`);
  if (outcome.recorded === 'verified') return { status: 'success', message: `Verified: ${outcome.detail}` };
  return { status: 'error', message: outcome.recorded === 'degraded' ? `Check failed and the integration is now degraded: ${outcome.detail}` : `Nothing was verified: ${outcome.detail}` };
}


/**
 * The executor bound to this deployment. NONE is bound today (a build needs a CI worker or container the owner provides), so the runner records
 * the truthful `environment_missing` blocker. When one exists it is returned here, and nothing else in the path changes.
 */
function boundBuildExecutor(): Executor {
  return notConfiguredExecutor;
}

/** Run the build for one development build NOW: stage by stage, recorded through the doors, never faked. */
export async function runBuildAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const refused = await gate();
  if (refused) return refused;
  const projectId = text(formData, 'projectId');
  const deliverableId = text(formData, 'deliverableId');
  const supabase = await createClient();
  const { data: dd, error } = await supabase
    .schema('projects')
    .from('deliverable_details')
    .select('commit_ref, target_env, deliverable_id')
    .eq('deliverable_id', deliverableId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) return { status: 'error', message: 'The build could not be read; nothing was run.' };
  const commit = (dd?.commit_ref ?? '').trim();
  if (!dd || !commit) return { status: 'error', message: 'This build names no exact commit, so it cannot be built.' };
  const admin = createAdminClient();
  const rpc = (admin.schema('projects') as unknown as { rpc(name: string, args: unknown): PromiseLike<{ data: unknown }> });
  const result = await runBuild(boundBuildExecutor(), {
    deliverableId,
    commit,
    environment: (['dev', 'review', 'staging', 'client_test'] as const).find((e) => e === dd.target_env) ?? 'review',
    record: async (a) => {
      const { data } = await rpc.rpc('record_build_run', {
        p_deliverable_id: deliverableId,
        p_environment: (['dev', 'review', 'staging', 'client_test'] as const).find((e) => e === dd.target_env) ?? 'review',
        p_status: a.status,
        p_failure_class: a.failureClass,
        p_stages: a.stages,
        p_fingerprint: a.fingerprint,
        p_artifact_sha256: a.artifactSha256,
        p_retry_of: a.retryOf,
        p_idempotency_key: a.idempotencyKey,
      });
      const row = first(data) as { outcome?: string; run_id?: string };
      return { outcome: String(row.outcome ?? 'no answer'), runId: row.run_id ?? null };
    },
    recordSmoke: async (a) => {
      await rpc.rpc('record_smoke_check', { p_deliverable_id: deliverableId, p_result: a.result, p_checks: a.checks, p_device_target: a.deviceTarget, p_reason: a.reason, p_evidence_url: a.evidenceUrl });
    },
    recordArtifact: async (a) => {
      await rpc.rpc('record_build_artifact', { p_build_run_id: a.runId, p_artifact_type: a.type, p_storage_ref: a.storageRef, p_platform: a.platform, p_size_bytes: a.sizeBytes, p_distributable: a.distributable, p_limitation: a.limitation });
    },
  });
  revalidatePath(`/projects/${projectId}`);
  if (result.status === 'succeeded') return { status: 'success', message: 'Built and the artifact verified; the run is recorded on this exact commit.' };
  if (result.failureClass === 'environment_missing') return { status: 'error', message: 'No build executor is bound to this deployment, so nothing was built. The blocker is recorded; connect a CI worker to build.' };
  return { status: 'error', message: `The build ${result.status}: ${result.detail}` };
}


/**
 * Route the approved plan's tasks again: a task that was HELD (a dependency was open, the specialist was disabled) is re-evaluated against the
 * facts as they are now. It is the same handler the plan-approved event runs, so a task already handed off is left alone and nothing is routed twice.
 */
export async function rerouteHeldTasksAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const refused = await gate();
  if (refused) return refused;
  const projectId = text(formData, 'projectId');
  const supabase = await createClient();
  const { data: plan, error } = await supabase
    .schema('projects')
    .from('development_plans')
    .select('id, organization_id')
    .eq('project_id', projectId)
    .eq('status', 'approved')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { status: 'error', message: 'The plan could not be read; nothing was routed.' };
  if (!plan) return { status: 'error', message: 'There is no approved development plan to route.' };
  const result = await handleRouteDevelopmentPlan(createAdminClient(), {
    id: `manual-reroute:${plan.id}`,
    organization_id: plan.organization_id as string,
    correlation_id: plan.id as string,
    payload: { subjectId: plan.id as string } as never,
  });
  revalidatePath(`/projects/${projectId}`);
  if (result.status === 'failed') return { status: 'error', message: `Routing stopped: ${result.detail}` };
  return { status: 'success', message: result.detail ?? 'Routed.' };
}


/** A smoke/launch verdict for the build's exact commit: passed (with checks and evidence), failed, blocked, or honestly not tested. */
export async function recordSmokeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const checks = text(formData, 'checks').split('\n').map((l) => l.trim()).filter(Boolean).map((name) => ({ name }));
  return run(text(formData, 'projectId'), 'record_smoke_check', {
    p_deliverable_id: text(formData, 'deliverableId'),
    p_result: text(formData, 'result'),
    p_checks: checks,
    p_device_target: text(formData, 'deviceTarget') || null,
    p_reason: text(formData, 'reason') || null,
    p_evidence_url: text(formData, 'evidenceUrl') || null,
  }, ['recorded']);
}

export async function resolveBuildBlockerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'resolve_build_blocker', { p_blocker_id: text(formData, 'blockerId') }, ['resolved']);
}
