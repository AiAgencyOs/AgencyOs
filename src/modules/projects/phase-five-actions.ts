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
