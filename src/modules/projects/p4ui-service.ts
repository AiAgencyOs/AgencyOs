import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * The human side of the Phase 4 UI Designer / Prototype records: the doors a PERSON walks through (resolve a blocker, classify feedback, decide a post-lock
 * request, confirm a source-UI defect, record Figma references). The doors themselves refuse an agent (person_required / admin_required) and re-check the
 * organization and role; this layer adds the capability check and turns each outcome into a message, never a guess.
 */

type Rpc = { schema(name: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };

const MESSAGES: Record<string, string> = {
  person_required: 'This needs a person, not an agent.',
  admin_required: 'Only an Admin can do this.',
  forbidden: 'You do not have permission to do this.',
  no_actor: 'You are not signed in.',
  unknown_version: 'That UI version was not found.',
  unknown_blocker: 'That blocker was not found.',
  unknown_issue: 'That issue was not found.',
  unknown_request: 'That request was not found.',
  unknown_deliverable: 'That prototype was not found.',
  already_resolved: 'It is already resolved.',
  already_decided: 'It is already decided.',
  already_routed: 'It has already been classified.',
  wrong_state: 'It is not in a state where that can be done.',
  not_locked: 'Only a locked UI version can have a post-lock request.',
  needs_note: 'A note is required.',
  needs_reason: 'A reason is required.',
  needs_reasoning: 'A short reasoning is required.',
  bad_classification: 'That is not a classification.',
  would_replace: 'A different Figma file is already linked; state why it is being replaced.',
  unknown_screen: 'That screen is not part of this UI version.',
  needs_file_ref: 'A Figma file reference is required.',
};

async function walk(label: string, fn: string, args: Record<string, unknown>, okOutcomes: readonly string[], capability: 'project.write'): Promise<Result<{ outcome: string; refId: string | null }>> {
  const context = await requireInternal();
  if (!can(context, capability)) return err('FORBIDDEN', 'You do not have permission to change this project.');
  const supabase = (await createClient()) as unknown as Rpc;
  const { data, error } = await supabase.schema('projects').rpc(fn, args);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: label, detail: error.message }));
    return err('INTERNAL', 'Could not complete that.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; ref_id?: string | null } | undefined;
  const outcome = row?.outcome ?? '';
  if (okOutcomes.includes(outcome)) return ok({ outcome, refId: row?.ref_id ?? null });
  const message = MESSAGES[outcome];
  if (!message) console.error(JSON.stringify({ level: 'error', scope: label, detail: `unrecognised outcome "${outcome}"` }));
  return err(outcome === 'forbidden' || outcome === 'admin_required' || outcome === 'person_required' ? 'FORBIDDEN' : 'CONFLICT', message ?? 'Could not complete that.');
}

export const resolveDesignBlocker = (blockerId: string, note: string) =>
  walk('resolveDesignBlocker', 'p4ui_resolve_design_blocker', { p_blocker_id: blockerId, p_note: note }, ['resolved'], 'project.write');

export const resolvePrototypeBlocker = (blockerId: string, note: string) =>
  walk('resolvePrototypeBlocker', 'p4ui_resolve_prototype_blocker', { p_blocker_id: blockerId, p_note: note }, ['resolved'], 'project.write');

export const routeUiFeedback = (uiVersionId: string, classification: string, reasoning: string) =>
  walk('routeUiFeedback', 'p4ui_route_ui_feedback', { p_ui_version_id: uiVersionId, p_classification: classification, p_reasoning: reasoning }, ['routed'], 'project.write');

export const routePrototypeFeedback = (deliverableId: string, classification: string, reasoning: string) =>
  walk('routePrototypeFeedback', 'p4ui_route_prototype_feedback', { p_deliverable_id: deliverableId, p_classification: classification, p_reasoning: reasoning }, ['routed'], 'project.write');

export const requestPostLockRevision = (uiVersionId: string, kind: string, reason: string) =>
  walk('requestPostLockRevision', 'p4ui_request_post_lock_revision', { p_ui_version_id: uiVersionId, p_kind: kind, p_reason: reason }, ['requested', 'exists'], 'project.write');

export const decidePostLockRevision = (requestId: string, approve: boolean, note: string) =>
  walk('decidePostLockRevision', 'p4ui_decide_post_lock_revision', { p_request_id: requestId, p_approve: approve, p_note: note }, ['approved', 'rejected'], 'project.write');

export const confirmPrototypeDesignIssue = (issueId: string, isSourceUiDefect: boolean, note: string) =>
  walk('confirmPrototypeDesignIssue', 'p4ui_confirm_prototype_design_issue', { p_issue_id: issueId, p_is_source_ui_defect: isSourceUiDefect, p_note: note }, ['confirmed', 'dismissed_as_code_bug'], 'project.write');

export const recordFigmaRefs = (uiVersionId: string, fileRef: string, pageRef: string | null, replaceReason: string | null) =>
  walk('recordFigmaRefs', 'p4ui_record_figma_refs', { p_ui_version_id: uiVersionId, p_file_ref: fileRef, p_page_ref: pageRef, p_node_refs: {}, p_replace_reason: replaceReason }, ['recorded'], 'project.write');
