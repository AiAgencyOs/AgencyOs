import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * Doc 11 §16–§21 — the scope/change-request write surface.
 *
 * Thin on purpose, same reasoning `design.ts` states at length: the rules
 * live in `supabase/migrations/20260921190000_a_client_could_move_the_baseline.sql`,
 * because those are rules about what may be *stored*, and the database is the
 * only place that cannot be bypassed. This is the translation from a door's
 * outcome into a sentence somebody can act on.
 *
 * ── two different gates, on purpose ────────────────────────────────────
 *
 * `classifyChangeRequest` and `applyChangeRequest` check `milestone.write`
 * (owner, ops_admin, delivery_lead — the same set `core.can_manage_delivery()`
 * admits). `decideChangeRequest` is stricter: the door itself requires
 * `core.is_owner()`, because approving a change is the same kind of act as
 * signing a project production-ready — a delivery lead approving their own
 * team's change request would be the review signing its own homework. This
 * layer's own check for that one function matches the door's, so a reader of
 * this file does not have to open the migration to learn who may decide.
 */

function oneRow<T>(data: unknown): T | undefined {
  return (Array.isArray(data) ? data[0] : data) as T | undefined;
}

async function deliveryActor(): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to manage this project’s change requests.');
  }
  return ok(true);
}

async function ownerActor(): Promise<Result<true>> {
  const context = await requireInternal();
  if (context.role !== 'owner') {
    return err('FORBIDDEN', 'Only the owner may approve or reject a change request.');
  }
  return ok(true);
}

/** §16 — a request against the project's active scope baseline. */
export async function submitChangeRequest(input: {
  projectId: string;
  requested: string;
  source?: 'client' | 'internal';
  evidenceMessageId?: string;
}): Promise<Result<{ changeRequestId: string }>> {
  const gate = await deliveryActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('submit_change_request', {
    p_project_id: input.projectId,
    p_requested: input.requested,
    p_source: input.source ?? 'client',
    p_evidence_message_id: input.evidenceMessageId ?? null,
  });
  if (error) return err('INTERNAL', 'Could not submit the change request.');

  const row = oneRow<{ outcome?: string; change_request_id?: string | null }>(data);
  switch (row?.outcome ?? 'no answer') {
    case 'submitted':
      return ok({ changeRequestId: row?.change_request_id ?? '' });
    case 'not_found':
      return err('NOT_FOUND', 'That project does not exist.');
    case 'no_baseline':
      return err(
        'CONFLICT',
        'This project has no active scope baseline yet, so there is nothing for a change request to argue with.',
      );
    default:
      return err('FORBIDDEN', 'You do not have permission to submit a change request for this project.');
  }
}

/** §17 — the classification, and what it will cost. */
export async function classifyChangeRequest(input: {
  changeRequestId: string;
  classification: 'in_scope' | 'free_change' | 'paid_change' | 'new_project' | 'clarification' | 'duplicate' | 'rejected';
  impactNotes?: string;
  timelineDays?: number;
  effortHours?: number;
}): Promise<Result<{ status: string }>> {
  const gate = await deliveryActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('classify_change_request', {
    p_change_request_id: input.changeRequestId,
    p_classification: input.classification,
    p_impact_notes: input.impactNotes ?? null,
    p_timeline_days: input.timelineDays ?? null,
    p_effort_hours: input.effortHours ?? null,
  });
  if (error) return err('INTERNAL', 'Could not classify the change request.');

  const row = oneRow<{ outcome?: string; status?: string | null }>(data);
  switch (row?.outcome ?? 'no answer') {
    case 'classified':
      return ok({ status: row?.status ?? 'classified' });
    case 'not_found':
      return err('NOT_FOUND', 'That change request does not exist.');
    case 'already_decided':
      return err('CONFLICT', `This request is already ${row?.status}, so it cannot be reclassified.`);
    default:
      return err('FORBIDDEN', 'You do not have permission to classify this change request.');
  }
}

/** §18 — the owner's decision. A paid change must already name a proposal, or name one here. */
export async function decideChangeRequest(input: {
  changeRequestId: string;
  approve: boolean;
  proposalId?: string;
}): Promise<Result<{ status: string }>> {
  const gate = await ownerActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('decide_change_request', {
    p_change_request_id: input.changeRequestId,
    p_approve: input.approve,
    p_proposal_id: input.proposalId ?? null,
  });
  if (error) return err('INTERNAL', 'Could not decide the change request.');

  const row = oneRow<{ outcome?: string; status?: string | null }>(data);
  switch (row?.outcome ?? 'no answer') {
    case 'approved':
    case 'rejected':
      return ok({ status: row?.outcome as string });
    case 'not_found':
      return err('NOT_FOUND', 'That change request does not exist.');
    case 'not_decidable':
      return err('CONFLICT', `This request is ${row?.status}, which is not a state a decision can be made from.`);
    case 'unclassified':
      return err('CONFLICT', 'Classify this request before deciding it — an undecided classification is a guess about what was asked for.');
    case 'paid_change_needs_a_proposal':
      return err('VALIDATION', 'A paid change cannot be approved without naming the proposal that prices it (ADM-22).');
    default:
      return err('FORBIDDEN', 'You do not have permission to decide this change request.');
  }
}

/** §22 — an approved change opens the next scope baseline. */
export async function applyChangeRequest(input: {
  changeRequestId: string;
}): Promise<Result<{ scopeVersionId: string; version: number }>> {
  const gate = await deliveryActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('apply_change_request', {
    p_change_request_id: input.changeRequestId,
  });
  if (error) return err('INTERNAL', 'Could not apply the change request.');

  const row = oneRow<{ outcome?: string; scope_version_id?: string | null; version?: number | null }>(data);
  switch (row?.outcome ?? 'no answer') {
    case 'opened':
      return ok({ scopeVersionId: row?.scope_version_id ?? '', version: row?.version ?? 0 });
    case 'not_found':
      return err('NOT_FOUND', 'That change request does not exist.');
    case 'not_approved':
      return err('CONFLICT', 'Only an approved change request can be applied to the baseline.');
    case 'no_baseline':
      return err('CONFLICT', 'This project has no active scope baseline to open the next version from.');
    case 'draft_exists':
      return err(
        'CONFLICT',
        'A draft scope version already exists for this project. Resolve it on the Scope page before applying this change request.',
      );
    default:
      return err('FORBIDDEN', 'You do not have permission to apply this change request.');
  }
}
