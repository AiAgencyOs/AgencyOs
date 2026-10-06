'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Phase 7 Admin actions: ONE server action over a WHITELIST of database doors. Nothing here decides: each door checks the role, the state, the independence
 * rules (creator != approver, validator != deployer), the exact candidate and the gates under its own lock, and its answer is reported in plain words.
 * The door name comes from the form, but it can only select an entry of this table; an unknown name is refused, so a forged field reaches no other function.
 *
 * There is deliberately NO door here for recording a deployment, and none that marks production validated or the project complete by assertion: a
 * deployment is recorded only by the service-role runner, validation only by an independent person with evidence, completion only by the gate.
 */

type Fd = FormData;
const text = (fd: Fd, key: string) => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string) => text(fd, key) || null;
const yes = (fd: Fd, key: string) => text(fd, key) === 'yes';
const lines = (fd: Fd, key: string) => text(fd, key).split('\n').map((l) => l.trim()).filter(Boolean);

/** "none | reason" or one ordered step per line "name | yes|no" (reversible). Returned as the JSON object the door validates. */
function migrationPlan(fd: Fd): Record<string, unknown> {
  if (text(fd, 'migrationMode') !== 'steps') return { none: true, reason: text(fd, 'migrationReason') };
  const steps = lines(fd, 'migrationSteps').map((l, i) => {
    const [name, reversible] = l.split('|').map((s) => s.trim());
    return { order: i + 1, name: name ?? '', reversible: (reversible ?? 'yes').toLowerCase() !== 'no', ...(l.toLowerCase().includes('destructive') ? { destructive: true } : {}) };
  });
  return { steps, backupRequired: yes(fd, 'backup') };
}

type Door = { rpc: string; args: (fd: Fd) => Record<string, unknown>; ok: readonly string[] };

const DOORS: Record<string, Door> = {
  open: { rpc: 'open_phase_seven', args: (fd) => ({ p_project_id: text(fd, 'projectId') }), ok: ['ready', 'already_started', 'waiting_m4_verification', 'candidate_not_current'] },
  create_plan: {
    rpc: 'create_deployment_plan',
    args: (fd) => ({
      p_project_id: text(fd, 'projectId'), p_target_ref: text(fd, 'targetRef'), p_migration_plan: migrationPlan(fd), p_rollback_strategy: optional(fd, 'rollbackStrategy'), p_rollback_target_ref: optional(fd, 'rollbackTarget'),
      p_rollback_owner: optional(fd, 'rollbackOwner'), p_monitoring_plan: optional(fd, 'monitoringPlan'), p_maintenance_window: optional(fd, 'maintenanceWindow'), p_no_config_required: yes(fd, 'noConfig'),
    }),
    ok: ['created'],
  },
  readiness: {
    rpc: 'record_readiness_item',
    args: (fd) => ({ p_plan_id: text(fd, 'planId'), p_kind: text(fd, 'kind'), p_name: text(fd, 'name'), p_status: text(fd, 'status'), p_evidence_ref: optional(fd, 'evidenceRef'), p_owner: optional(fd, 'owner'), p_instruction: optional(fd, 'instruction'), p_note: optional(fd, 'note') }),
    ok: ['recorded'],
  },
  request_approval: { rpc: 'request_deployment_approval', args: (fd) => ({ p_plan_id: text(fd, 'planId') }), ok: ['requested', 'already_requested'] },
  decide_plan: { rpc: 'decide_deployment_plan', args: (fd) => ({ p_plan_id: text(fd, 'planId'), p_decision: text(fd, 'decision'), p_note: optional(fd, 'note'), p_ack_destructive: yes(fd, 'ackDestructive') }), ok: ['approved', 'rejected', 'sent_back'] },
  open_run: { rpc: 'open_validation_run', args: (fd) => ({ p_deployment_id: text(fd, 'deploymentId'), p_kind: text(fd, 'kind'), p_incident_id: optional(fd, 'incidentId') }), ok: ['opened', 'already_running'] },
  check: {
    rpc: 'record_validation_check',
    args: (fd) => ({ p_run_id: text(fd, 'runId'), p_check_key: text(fd, 'checkKey'), p_truth: text(fd, 'truth'), p_evidence_ref: optional(fd, 'evidenceRef'), p_detail: optional(fd, 'detail'), p_required: !yes(fd, 'optionalCheck') }),
    ok: ['recorded'],
  },
  finish_run: { rpc: 'finish_validation_run', args: (fd) => ({ p_run_id: text(fd, 'runId'), p_summary: optional(fd, 'summary') }), ok: ['finished'] },
  raise_incident: { rpc: 'raise_incident', args: (fd) => ({ p_deployment_id: text(fd, 'deploymentId'), p_type: text(fd, 'type'), p_severity: text(fd, 'severity'), p_impact: optional(fd, 'impact'), p_note: text(fd, 'note') }), ok: ['raised'] },
  classify_incident: { rpc: 'classify_incident', args: (fd) => ({ p_incident_id: text(fd, 'incidentId'), p_path: text(fd, 'path'), p_note: optional(fd, 'note') }), ok: ['classified'] },
  incident_action: { rpc: 'record_incident_action', args: (fd) => ({ p_incident_id: text(fd, 'incidentId'), p_kind: text(fd, 'kind'), p_note: text(fd, 'note'), p_evidence_ref: optional(fd, 'evidenceRef') }), ok: ['recorded'] },
  decide_rollback: {
    rpc: 'decide_rollback',
    args: (fd) => ({ p_incident_id: text(fd, 'incidentId'), p_target_ref: text(fd, 'targetRef'), p_risk: text(fd, 'risk'), p_decision: text(fd, 'decision'), p_reason: optional(fd, 'reason'), p_irreversible_acknowledged: yes(fd, 'ackIrreversible') }),
    ok: ['approved', 'rejected'],
  },
  close_incident: { rpc: 'close_incident', args: (fd) => ({ p_incident_id: text(fd, 'incidentId'), p_root_cause: text(fd, 'rootCause'), p_timeline_summary: optional(fd, 'timeline'), p_corrective_actions: text(fd, 'correctiveActions') }), ok: ['closed'] },
  change: { rpc: 'record_production_change', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_kind: text(fd, 'kind'), p_description: text(fd, 'description'), p_affected_categories: fd.getAll('categories').map(String) }), ok: ['recorded'] },
  rebind: { rpc: 'rebind_phase_seven_candidate', args: (fd) => ({ p_project_id: text(fd, 'projectId') }), ok: ['rebound', 'unchanged'] },
  limitation: { rpc: 'record_known_limitation', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_title: text(fd, 'title'), p_detail: optional(fd, 'detail'), p_source: 'manual' }), ok: ['recorded'] },
  contract: { rpc: 'record_contract_deliverable', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_kind: text(fd, 'kind'), p_label: text(fd, 'label'), p_required: yes(fd, 'required'), p_exclusion_reason: optional(fd, 'exclusionReason') }), ok: ['recorded'] },
  create_package: {
    rpc: 'create_handover_package',
    args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_production_url: optional(fd, 'productionUrl'), p_support_terms: optional(fd, 'supportTerms'), p_warranty_ends_on: optional(fd, 'warrantyEndsOn'), p_emergency_contacts: optional(fd, 'emergencyContacts') }),
    ok: ['created', 'already_exists'],
  },
  update_package: {
    rpc: 'update_handover_package',
    args: (fd) => ({ p_package_id: text(fd, 'packageId'), p_production_url: optional(fd, 'productionUrl'), p_support_terms: optional(fd, 'supportTerms'), p_warranty_ends_on: optional(fd, 'warrantyEndsOn'), p_emergency_contacts: optional(fd, 'emergencyContacts') }),
    ok: ['updated'],
  },
  set_item: { rpc: 'set_handover_item', args: (fd) => ({ p_package_id: text(fd, 'packageId'), p_kind: text(fd, 'kind'), p_status: text(fd, 'status'), p_artifact_ref: optional(fd, 'artifactRef'), p_evidence_ref: optional(fd, 'evidenceRef'), p_reason: optional(fd, 'reason') }), ok: ['recorded'] },
  access_transfer: {
    rpc: 'record_access_transfer',
    args: (fd) => ({
      p_package_id: text(fd, 'packageId'), p_system_name: text(fd, 'system'), p_kind: text(fd, 'kind'), p_method: text(fd, 'method'), p_status: text(fd, 'status'), p_from_party: optional(fd, 'fromParty'), p_to_party: optional(fd, 'toParty'),
      p_evidence_ref: optional(fd, 'evidenceRef'), p_credentials_rotated: yes(fd, 'rotated'), p_support_access_retained: yes(fd, 'supportRetained'), p_support_access_authorized: yes(fd, 'supportAuthorized'), p_note: optional(fd, 'note'),
    }),
    ok: ['recorded'],
  },
  submit_package: { rpc: 'submit_handover_for_review', args: (fd) => ({ p_package_id: text(fd, 'packageId') }), ok: ['submitted'] },
  decide_package: { rpc: 'decide_handover_package', args: (fd) => ({ p_package_id: text(fd, 'packageId'), p_decision: text(fd, 'decision'), p_note: optional(fd, 'note') }), ok: ['approved', 'edit_requested'] },
  revise_package: { rpc: 'revise_handover_package', args: (fd) => ({ p_package_id: text(fd, 'packageId') }), ok: ['revised'] },
  deliver_package: { rpc: 'deliver_handover_package', args: (fd) => ({ p_package_id: text(fd, 'packageId'), p_channel: text(fd, 'channel') }), ok: ['delivered', 'already_delivered'] },
  acceptance: {
    rpc: 'record_client_acceptance',
    args: (fd) => ({ p_package_id: text(fd, 'packageId'), p_decision: text(fd, 'decision'), p_evidence_kind: text(fd, 'evidenceKind'), p_evidence_ref: text(fd, 'evidenceRef'), p_client_name: text(fd, 'clientName'), p_note: optional(fd, 'note') }),
    ok: ['recorded'],
  },
  acceptance_policy: { rpc: 'set_acceptance_policy', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_required: !yes(fd, 'waive'), p_reason: optional(fd, 'reason') }), ok: ['set'] },
  feedback: { rpc: 'record_handover_feedback', args: (fd) => ({ p_package_id: text(fd, 'packageId'), p_classification: text(fd, 'classification'), p_body: text(fd, 'body') }), ok: ['recorded'] },
  resolve_feedback: { rpc: 'resolve_handover_feedback', args: (fd) => ({ p_feedback_id: text(fd, 'feedbackId'), p_resolution: text(fd, 'resolution') }), ok: ['resolved'] },
  finance_open: { rpc: 'open_financial_exception', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_kind: text(fd, 'kind'), p_amount_minor: null, p_note: text(fd, 'note') }), ok: ['opened'] },
  finance_decide: { rpc: 'decide_financial_exception', args: (fd) => ({ p_exception_id: text(fd, 'exceptionId'), p_decision: text(fd, 'decision'), p_resolution: text(fd, 'resolution'), p_evidence_ref: optional(fd, 'evidenceRef') }), ok: ['decided'] },
  completion_exception: { rpc: 'approve_completion_exception', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_gate: text(fd, 'gate'), p_reason: text(fd, 'reason'), p_risk: text(fd, 'risk') }), ok: ['approved'] },
  complete: { rpc: 'complete_phase_seven', args: (fd) => ({ p_project_id: text(fd, 'projectId') }), ok: ['completed', 'already_completed'] },
};

const WORDS: Record<string, string> = {
  ready: 'Phase 7 is ready.',
  already_started: 'Phase 7 had already started.',
  waiting_m4_verification: 'Phase 7 exists but waits: M4 is not verified paid in full.',
  candidate_not_current: 'The approved candidate is not current: a new governed candidate is needed.',
  created: 'Created.',
  recorded: 'Recorded.',
  requested: 'Requested.',
  already_requested: 'Already requested.',
  approved: 'Approved.',
  rejected: 'Rejected.',
  sent_back: 'Sent back for changes.',
  opened: 'Opened.',
  already_running: 'That run is already running.',
  finished: 'Run finished. Read its result: a pass needs every required check passed with evidence.',
  raised: 'Incident raised. Completion is paused.',
  classified: 'Classified.',
  closed: 'Incident closed after verified recovery and review.',
  rebound: 'The new approved candidate is bound to Phase 7.',
  unchanged: 'Nothing changed.',
  already_exists: 'A live version already exists.',
  updated: 'Updated.',
  submitted: 'Submitted for Admin review.',
  edit_requested: 'Edits requested.',
  revised: 'A new version was created; the old one is preserved.',
  delivered: 'Delivered.',
  already_delivered: 'Already delivered.',
  resolved: 'Resolved.',
  decided: 'Decided.',
  set: 'Saved.',
  completed: 'The project is completed: the immutable completion record and the Customer Success intake were written.',
  already_completed: 'Already completed: the one completion record stands.',
  not_authorized: 'You do not have permission to do this.',
  creator_cannot_approve: 'The person who built the plan cannot approve it.',
  not_ready: 'Not ready: a gate is unsatisfied (see the gates).',
  gate_not_satisfied: 'The completion gate is not satisfied (see the gates).',
  incomplete: 'The package is incomplete or stale (see its completeness).',
  not_independent: 'The person who executed the deployment does not validate it.',
  no_actor: 'This must be done by a signed-in person.',
  contains_secret: 'That text looks like a secret. Secrets are never stored: record a reference and use the secure transfer.',
  informal_is_not_acceptance: 'A casual "looks good" is not a formal acceptance: record the signed document, portal confirmation, email reply, call or minutes.',
  package_superseded: 'That version was superseded: acceptance applies to the exact current version.',
  not_admin_approved: 'Only an Admin-approved version is delivered.',
  phase_seven_not_ready: 'Phase 7 is not ready: M4 must be verified and the exact candidate must be current.',
  code_change_open: 'A code change is open: a new approved candidate is needed first.',
  recovery_not_verified: 'Recovery is not verified: a passed re-validation tied to this incident is required.',
  production_not_validated: 'Production is not validated for the current candidate.',
  contract_deliverables_missing: 'Record the contractual deliverables first.',
  not_revalidated: 'The new candidate does not satisfy every Phase 6 gate yet.',
  evidence_required: 'Evidence is required.',
  note_required: 'A note is required.',
  reason_required: 'A reason is required.',
};

export async function phaseSevenDoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this project.' };
  const name = text(formData, 'door');
  const door = Object.prototype.hasOwnProperty.call(DOORS, name) ? DOORS[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc(door.rpc as never, door.args(formData) as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null; missing?: string[] | null };
  const outcome = String(row.outcome ?? 'no answer');
  const missing = Array.isArray(row.missing) && row.missing.length > 0 ? ` ${row.missing.join(' | ')}` : '';
  if (!door.ok.includes(outcome)) return { status: 'error', message: `${WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`}${missing}` };
  revalidatePath(`/projects/${text(formData, 'projectId')}`);
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}
