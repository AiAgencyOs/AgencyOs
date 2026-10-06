'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Phase 6 Admin actions: ONE server action over a WHITELIST of database doors. Nothing here decides: each door checks the role, the state, the
 * independence rules and the gates under its own lock, and its answer is reported in plain words. The door name comes from the form, but it can only
 * select an entry of this table; an unknown name is refused, so a forged field cannot reach any other function.
 */

type Fd = FormData;
const text = (fd: Fd, key: string) => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string) => text(fd, key) || null;
const lines = (fd: Fd, key: string) => text(fd, key).split('\n').map((l) => l.trim()).filter(Boolean);

type Door = { schema: 'projects' | 'qa'; rpc: string; args: (fd: Fd) => Record<string, unknown>; ok: readonly string[] };

const DOORS: Record<string, Door> = {
  validate_intake: { schema: 'projects', rpc: 'validate_qa_intake', args: (fd) => ({ p_project_id: text(fd, 'projectId') }), ok: ['validated'] },
  create_plan: {
    schema: 'qa',
    rpc: 'create_master_test_plan',
    args: (fd) => ({
      p_project_id: text(fd, 'projectId'),
      p_required_categories: fd.getAll('categories').map(String),
      p_critical_journeys: lines(fd, 'journeys'),
      p_environments: lines(fd, 'environments'),
      p_test_data_strategy: optional(fd, 'dataStrategy'),
      p_performance_method: optional(fd, 'performanceMethod'),
    }),
    ok: ['created'],
  },
  add_risk: {
    schema: 'qa',
    rpc: 'add_risk_item',
    args: (fd) => ({ p_plan_id: text(fd, 'planId'), p_area: text(fd, 'area'), p_kind: text(fd, 'kind'), p_level: text(fd, 'level'), p_depth: text(fd, 'depth'), p_reason: text(fd, 'reason') }),
    ok: ['added'],
  },
  add_case: {
    schema: 'qa',
    rpc: 'add_phase6_case',
    args: (fd) => ({
      p_plan_id: text(fd, 'planId'), p_title: text(fd, 'title'), p_acceptance_criterion: text(fd, 'criterion'), p_category: text(fd, 'category'), p_priority: text(fd, 'priority') || 'medium',
      p_scope_item_id: optional(fd, 'scopeItemId'), p_journey: optional(fd, 'journey'), p_steps: optional(fd, 'steps'), p_expected: optional(fd, 'expected'),
    }),
    ok: ['added'],
  },
  approve_plan: { schema: 'qa', rpc: 'approve_master_test_plan', args: (fd) => ({ p_plan_id: text(fd, 'planId') }), ok: ['approved', 'already_approved'] },
  case_result: {
    schema: 'qa',
    rpc: 'record_case_result',
    args: (fd) => ({ p_case_id: text(fd, 'caseId'), p_status: text(fd, 'status'), p_evidence_ref: optional(fd, 'evidenceRef'), p_reason: optional(fd, 'reason') }),
    ok: ['recorded'],
  },
  triage: {
    schema: 'qa',
    rpc: 'triage_defect',
    args: (fd) => ({ p_defect_id: text(fd, 'defectId'), p_s_level: Number(text(fd, 'sLevel') || '2'), p_classification: text(fd, 'classification'), p_assignee_id: null, p_reason: optional(fd, 'reason') }),
    ok: ['triaged'],
  },
  hand_off: { schema: 'qa', rpc: 'hand_off_defect', args: (fd) => ({ p_defect_id: text(fd, 'defectId') }), ok: ['handed_off', 'already_handed_off'] },
  retest: {
    schema: 'qa',
    rpc: 'record_retest',
    args: (fd) => ({ p_defect_id: text(fd, 'defectId'), p_passed: text(fd, 'passed') === 'yes', p_retest_commit: text(fd, 'retestCommit'), p_retest_evidence: text(fd, 'retestEvidence') }),
    ok: ['verified', 'reopened'],
  },
  create_candidate: { schema: 'qa', rpc: 'create_release_candidate', args: (fd) => ({ p_project_id: text(fd, 'projectId') }), ok: ['created'] },
  prerequisites: {
    schema: 'qa',
    rpc: 'set_candidate_prerequisites',
    args: (fd) => ({
      p_candidate_id: text(fd, 'candidateId'), p_config_version: text(fd, 'configVersion'), p_rollback_plan: text(fd, 'rollbackPlan'), p_rollback_owner: text(fd, 'rollbackOwner'),
      p_observability_notes: text(fd, 'observability'),
    }),
    ok: ['set'],
  },
  category_result: {
    schema: 'qa',
    rpc: 'record_category_result',
    args: (fd) => ({ p_candidate_id: text(fd, 'candidateId'), p_category: text(fd, 'category'), p_status: text(fd, 'status'), p_evidence_ref: optional(fd, 'evidenceRef'), p_reason: optional(fd, 'reason') }),
    ok: ['recorded'],
  },
  evaluate: { schema: 'qa', rpc: 'evaluate_readiness', args: (fd) => ({ p_candidate_id: text(fd, 'candidateId') }), ok: ['evaluated'] },
  submit_review: { schema: 'qa', rpc: 'submit_candidate_for_review', args: (fd) => ({ p_candidate_id: text(fd, 'candidateId') }), ok: ['in_review'] },
  decide: {
    schema: 'qa',
    rpc: 'decide_release_candidate',
    args: (fd) => ({ p_candidate_id: text(fd, 'candidateId'), p_decision: text(fd, 'decision'), p_note: optional(fd, 'note') }),
    ok: ['approved', 'sent_back', 'blocked'],
  },
  request_exception: {
    schema: 'qa',
    rpc: 'request_release_exception',
    args: (fd) => ({
      p_candidate_id: text(fd, 'candidateId'), p_gate: text(fd, 'gate'), p_risk: text(fd, 'risk'), p_business_reason: text(fd, 'businessReason'), p_mitigation: text(fd, 'mitigation'),
      p_owner: text(fd, 'owner'), p_containment_plan: text(fd, 'containment'), p_expires_at: new Date(Date.now() + (Number(text(fd, 'days') || '14') * 86_400_000)).toISOString(),
    }),
    ok: ['requested'],
  },
  approve_exception: { schema: 'qa', rpc: 'approve_release_exception', args: (fd) => ({ p_exception_id: text(fd, 'exceptionId') }), ok: ['approved', 'already_approved'] },
  complete_phase: { schema: 'projects', rpc: 'complete_phase', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_phase: 6 }), ok: ['completed', 'already_completed'] },
};

const WORDS: Record<string, string> = {
  validated: 'Intake validated.',
  created: 'Created.',
  added: 'Added.',
  approved: 'Approved.',
  already_approved: 'Already approved.',
  recorded: 'Recorded.',
  triaged: 'Triaged.',
  handed_off: 'Handed to the Bug Fix capability with the exact build and the required retest.',
  already_handed_off: 'Already handed off.',
  verified: 'Verified by an independent retest of the fixed build.',
  reopened: 'The retest failed: the defect is reopened.',
  set: 'Recorded.',
  evaluated: 'Readiness evaluated; read the gates, not the score.',
  in_review: 'Sent to Admin review.',
  sent_back: 'Sent back for the requested work; no approval carries over.',
  blocked: 'Blocked.',
  requested: 'Requested. It is not an exception until the owner approves it.',
  completed: 'Phase 6 completed.',
  already_completed: 'Phase 6 was already completed.',
  not_authorized: 'You do not have permission to do this.',
  self_review: 'You produced this build, so you cannot record its result.',
  evidence_required: 'Evidence is required.',
  reason_required: 'A reason is required.',
  critical_cannot_be_skipped: 'A critical case is never skipped.',
  cases_not_passing: 'Not every case of this category passed on this commit.',
  stale_plan: 'The build changed since the plan was approved; evidence for it would be about different code.',
  depth_cannot_be_reduced: 'Payment, authentication, authorization, tenant data and destructive work cannot be recorded low or shallow.',
  not_approvable: 'Still has problems; they are listed.',
  not_ready: 'Not ready: a hard gate is unsatisfied. See the gates.',
  wrong_candidate: 'That candidate is not under review (it was superseded, blocked or already decided).',
  gate_cannot_be_excepted: 'Policy does not allow an exception for this gate.',
  expiry_required_within_90_days: 'An exception needs an expiry within 90 days.',
  requester_cannot_approve: 'The person who asked for an exception cannot approve it.',
  retest_on_the_wrong_build: 'The retest must run on the FIXED build, not the build the defect was found on.',
  fixer_cannot_verify: 'The person who fixed a defect cannot verify it.',
  retest_incomplete: 'A retest names the commit it ran on and its evidence.',
  not_fix_ready: 'The defect has not been marked fixed.',
  intake_not_valid: 'The QA intake is not valid yet.',
  no_approved_plan: 'There is no approved Master Test Plan.',
  candidate_exists_for_this_commit: 'A candidate for this exact commit already exists.',
  note_required: 'A note is required.',
  not_a_product_defect: 'Only a product defect is handed to development.',
};

export async function phaseSixDoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this project.' };
  const name = text(formData, 'door');
  const door = Object.prototype.hasOwnProperty.call(DOORS, name) ? DOORS[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };

  const supabase = await createClient();
  const { data, error } = await supabase.schema(door.schema).rpc(door.rpc as never, door.args(formData) as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null; result?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  const refusal = WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;
  if (!door.ok.includes(outcome)) return { status: 'error', message: refusal };
  revalidatePath(`/projects/${text(formData, 'projectId')}`);
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}
