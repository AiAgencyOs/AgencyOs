'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

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
