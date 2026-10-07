'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * PM5/PM6 depth actions - one thin action per database door (share a build, record the relay, record a revision round, decide an escalated
 * limit). Nothing here decides: each door checks the role, the gates and the allowance under its own lock, and its answer is shown in words.
 */

const WORDS: Record<string, string> = {
  shared: 'Recorded: this exact build is now the review share. Relay it to the client, then record that you did.',
  already_shared: 'That build and commit were already shared.',
  recorded: 'Recorded.',
  resolved: 'Decision recorded.',
  not_authorized: 'You do not have permission to do this.',
  not_found: 'That record was not found.',
  not_admin_approved: 'The Admin has not approved this exact build.',
  commit_changed_since_approval: 'The commit is not the one the Admin approved.',
  not_qa_passed: 'The build has not passed QA.',
  no_smoke: 'The build has no smoke verdict on its current commit.',
  no_build_run: 'There is no successful build run on this exact commit.',
  open_blocker: 'A build blocker is still open.',
  no_commit: 'This build names no exact commit.',
  platform_required: 'Name the platform to test on.',
  url_must_be_https: 'The review link must be an https address.',
  instructions_required: 'Say how to test the build.',
  superseded: 'That build was superseded.',
  revision_limit_reached: 'The included revision rounds are used. The request was NOT opened: it waits for an Admin decision under "Waiting for a decision".',
  escalated_awaiting_decision: 'A revision-limit decision is already waiting; no further client round opens until it is made.',
  not_a_later_build: 'The revised build must be a later version than the one it revises.',
  build_not_on_project: 'Both builds must belong to this project.',
  feature_not_on_project: 'A selected feature is not on this project.',
  change_request_not_approved: 'An approved-change revision needs an approved Change Request on this project.',
  change_request_only_for_approved_change: 'A Change Request belongs only to an approved-change revision.',
  already_recorded: 'That revision is already recorded.',
  reason_required: 'Say why the revision was made.',
  note_required: 'A decision needs a reason.',
  extra_rounds_mismatch: 'Extra rounds are needed for a grant, and only for a grant (at most 10).',
  already_resolved: 'That escalation was already decided.',
};

type Door = { outcome?: string | null };
const first = (data: unknown): Door => ((Array.isArray(data) ? data[0] : data) ?? {}) as Door;
const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();

async function run(projectId: string, rpc: string, args: Record<string, unknown>, success: readonly string[]): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this project.' };
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc(rpc as never, args as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const outcome = String(first(data).outcome ?? 'no answer');
  const message = WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;
  if (!success.includes(outcome)) return { status: 'error', message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message };
}

export async function shareBuildForReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'share_build_with_client', {
    p_deliverable_id: text(formData, 'deliverableId'),
    p_review_platform: text(formData, 'reviewPlatform'),
    p_review_url: text(formData, 'reviewUrl'),
    p_testing_instructions: text(formData, 'testingInstructions'),
  }, ['shared']);
}

export async function recordShareDeliveryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'record_build_share_delivery', {
    p_share_id: text(formData, 'shareId'),
    p_state: text(formData, 'state'),
    p_note: text(formData, 'note') || null,
  }, ['recorded']);
}

export async function recordBuildRevisionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const featureIds = formData.getAll('featureIds').map(String).filter((v) => v.length > 0);
  return run(text(formData, 'projectId'), 'record_build_revision', {
    p_project_id: text(formData, 'projectId'),
    p_origin: text(formData, 'origin'),
    p_from_deliverable_id: text(formData, 'fromDeliverableId'),
    p_to_deliverable_id: text(formData, 'toDeliverableId'),
    p_reason: text(formData, 'reason'),
    p_feature_ids: featureIds,
    p_change_request_id: text(formData, 'changeRequestId') || null,
  }, ['recorded']);
}

export async function resolveRevisionEscalationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return run(text(formData, 'projectId'), 'resolve_build_revision_escalation', {
    p_escalation_id: text(formData, 'escalationId'),
    p_decision: text(formData, 'decision'),
    p_note: text(formData, 'note'),
    p_extra_rounds: Number(text(formData, 'extraRounds') || '0'),
  }, ['resolved']);
}
