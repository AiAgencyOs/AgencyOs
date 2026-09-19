import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * Phase 3's write surface — Master §16, §10; Designer §15; PM §7; G-287.
 *
 * G-280 built the gate order and G-286 rendered the trail it produces. Between
 * them sat three doors nothing called: `submit_internal_design_review`,
 * `submit_admin_design_decision` and `assign_design_reviewer`. The order was
 * enforceable and could not be exercised.
 *
 * Thin on purpose, for the same reason `planning.ts` is. Every rule the gate
 * order keeps lives in the migration — the reviewer must be the assigned
 * person, Admin cannot decide on an option internal review has not passed, an
 * EDIT returns both gates — because those are rules about what may be
 * *stored*, and the database is the only place that cannot be bypassed. What
 * is here is the translation from a door's outcome into a sentence somebody
 * can act on.
 *
 * ── the refusals are not collapsed ────────────────────────────────────
 *
 * Each outcome gets its own message. `not_the_reviewer` and
 * `no_reviewer_assigned` are different problems with different fixes — one
 * needs a different person, the other needs somebody appointed — and
 * answering "you cannot do that" to both would leave the reader to guess
 * which. The same argument G-282's share makes for naming the offending
 * options.
 *
 * ── this layer does not decide who may act ────────────────────────────
 *
 * It checks `project.write` to keep a reader off a form they cannot submit,
 * and the doors check again. The *authority* checks are the doors': the
 * internal gate wants the **assigned reviewer** specifically, which no
 * capability can express, and the Admin gate reuses `project.sign_off`'s role
 * set. A capability check here that disagreed with either would be a second
 * opinion about who holds a gate.
 */

async function designActor(): Promise<Result<true>> {
  const context = await requireInternal();
  // The same capability that governs the project. Phase 3 is project work, and
  // no new capability was invented for it — the doors hold the finer rules.
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to change this project’s design work.');
  }
  return ok(true);
}

function oneRow<T>(data: unknown): T | undefined {
  return (Array.isArray(data) ? data[0] : data) as T | undefined;
}

/** §16 — the internal gate, which happens before Admin sees anything. */
export async function submitInternalDesignReview(input: {
  themeOptionId: string;
  result: 'passed' | 'changes_required';
  comments?: string;
}): Promise<Result<{ reviewId: string | null }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('submit_internal_design_review', {
    p_theme_option_id: input.themeOptionId,
    p_result: input.result,
    p_comments: input.comments ?? null,
  });
  if (error) return err('INTERNAL', 'Could not record the review.');

  const row = oneRow<{ outcome?: string; review_id?: string | null }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'recorded':
      return ok({ reviewId: row?.review_id ?? null });
    case 'no_reviewer_assigned':
      return err(
        'CONFLICT',
        'No internal design reviewer is assigned to this project. An Admin has to appoint one before this gate can be used.',
      );
    case 'not_the_reviewer':
      return err(
        'FORBIDDEN',
        'Only the assigned internal design reviewer may record this review.',
      );
    case 'needs_comments':
      return err(
        'VALIDATION',
        'Say what has to change. A designer sent back without a reason has to guess what was wrong.',
      );
    case 'already_approved':
      return err('CONFLICT', 'Admin has already approved this option, so internal review is closed on it.');
    case 'bad_result':
      return err('VALIDATION', 'A review either passes or asks for changes.');
    case 'unknown_option':
      return err('NOT_FOUND', 'That theme option does not exist.');
    default:
      return err('FORBIDDEN', 'You do not have permission to review this design.');
  }
}

/** §16 — the Admin gate, which happens after internal review and before the client. */
export async function submitAdminDesignDecision(input: {
  themeOptionId: string;
  decision: 'confirm' | 'edit';
  reason?: string;
}): Promise<Result<{ decisionId: string | null }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('submit_admin_design_decision', {
    p_theme_option_id: input.themeOptionId,
    p_decision: input.decision,
    p_reason: input.reason ?? null,
  });
  if (error) return err('INTERNAL', 'Could not record the decision.');

  const row = oneRow<{ outcome?: string; decision_id?: string | null }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'recorded':
      return ok({ decisionId: row?.decision_id ?? null });
    case 'not_internally_passed':
      // The sentence §16 and PM §7 both state: the order is not advice.
      return err(
        'CONFLICT',
        'Internal review has not passed this option yet. The order is designer, internal review, then Admin — it cannot be collapsed to move faster.',
      );
    case 'needs_reason':
      return err(
        'VALIDATION',
        'Say what to change. An edit with no reason sends the option back to a designer who does not know what for.',
      );
    case 'not_admin':
      return err(
        'FORBIDDEN',
        'Only an Admin may confirm or edit a design option. A delivery lead approving their own team’s work is the review signing its own homework.',
      );
    case 'bad_decision':
      return err('VALIDATION', 'An Admin decision is either a confirmation or an edit. A rejection is an edit with a reason.');
    case 'unknown_option':
      return err('NOT_FOUND', 'That theme option does not exist.');
    default:
      return err('FORBIDDEN', 'You do not have permission to decide on this design.');
  }
}

/** §4 — appoint the person the internal gate belongs to. */
export async function assignDesignReviewer(input: {
  projectId: string;
  userId: string;
}): Promise<Result<{ changed: boolean }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('assign_design_reviewer', {
    p_project_id: input.projectId,
    p_user_id: input.userId,
  });
  if (error) return err('INTERNAL', 'Could not assign the reviewer.');

  const row = oneRow<{ outcome?: string }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'assigned':
      return ok({ changed: true });
    case 'unchanged':
      return ok({ changed: false });
    case 'no_phase_three':
      return err('CONFLICT', 'Phase 3 has not started for this project, so there is no gate to hold yet.');
    case 'unknown_user':
      return err('NOT_FOUND', 'That person is not on this organisation’s roster.');
    case 'not_admin':
      return err('FORBIDDEN', 'Only an Admin may appoint the internal design reviewer.');
    default:
      return err('FORBIDDEN', 'You do not have permission to appoint a reviewer.');
  }
}
