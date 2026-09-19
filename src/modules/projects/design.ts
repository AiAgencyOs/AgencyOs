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

/**
 * The client loop — Master §7.6, §8; PM §4.4, §4.6, §9; G-288.
 *
 * G-287 gave the two internal gates a surface. These are the three doors on
 * the other side of them, which also had no caller: recording what was sent,
 * recording what came back, and opening the revision a change request asks
 * for.
 *
 * ── recording is not sending, and the surface has to say so ───────────
 *
 * There is no channel on this deployment (BLK-003, BLK-007). `record_design_
 * share` was built to record a send a **person** performed, which is why it
 * requires an evidence reference. Nothing here contacts anybody, and the
 * wording on every form says which of the two it is doing — a button labelled
 * "send" over a door that only writes a row would be the most expensive lie
 * this surface could tell.
 */

/** §7.6 — record which options went to the client, and when. */
export async function recordDesignShare(input: {
  projectId: string;
  themeOptionIds: string[];
  channel: string;
  evidenceRef: string;
  conversationId?: string;
}): Promise<Result<{ shareId: string | null }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_design_share', {
    p_project_id: input.projectId,
    p_theme_option_ids: input.themeOptionIds,
    p_channel: input.channel,
    p_evidence_ref: input.evidenceRef,
    p_conversation_id: input.conversationId ?? null,
  });
  if (error) return err('INTERNAL', 'Could not record the share.');

  const row = oneRow<{ outcome?: string; share_id?: string | null; findings?: string[] | null }>(data);
  // §8's reason for naming them: a PM told "one of these is not approved" has
  // to go and find out which. Dropping the findings here would put the reader
  // back where the door was built to stop them being.
  const named = (row?.findings ?? []).map((f) => f.split(':').slice(1).join(':')).filter(Boolean);
  const list = named.length > 0 ? ` — ${named.join(', ')}` : '';

  switch (row?.outcome ?? 'no answer') {
    case 'shared':
      return ok({ shareId: row?.share_id ?? null });
    case 'not_approved':
      return err('CONFLICT', `Admin has not approved everything you picked${list}. Only approved options may reach a client.`);
    case 'nothing_to_show':
      return err('CONFLICT', `There is nothing to show for${list || ' one of these'}: no Figma reference and no preview. Sending it would be sending a name.`);
    case 'no_options':
      return err('VALIDATION', 'Pick at least one option to record.');
    case 'bad_channel':
      return err('VALIDATION', 'Say how it was sent — WhatsApp, email, or other.');
    case 'no_evidence':
      return err(
        'VALIDATION',
        'Paste the reference of the message you sent. A record of a client being shown something, that nobody can show them being shown, is a claim.',
      );
    case 'no_phase_three':
      return err('CONFLICT', 'Phase 3 has not started for this project.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record a share on this project.');
  }
}

/** §12 — turn what the client said into one of six classifications, keeping their words. */
export async function recordClientDesignDecision(input: {
  shareId: string;
  decision: string;
  clientWords: string;
  themeOptionId?: string;
  colorOptionId?: string;
  referenceUrl?: string;
  referenceNote?: string;
  evidenceRef?: string;
}): Promise<Result<{ decisionId: string | null }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_client_design_decision', {
    p_share_id: input.shareId,
    p_decision: input.decision,
    p_client_words: input.clientWords,
    p_theme_option_id: input.themeOptionId ?? null,
    p_color_option_id: input.colorOptionId ?? null,
    p_reference_url: input.referenceUrl ?? null,
    p_reference_note: input.referenceNote ?? null,
    p_evidence_ref: input.evidenceRef ?? null,
  });
  if (error) return err('INTERNAL', 'Could not record what the client said.');

  const row = oneRow<{ outcome?: string; decision_id?: string | null }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'recorded':
      return ok({ decisionId: row?.decision_id ?? null });
    case 'no_client_words':
      return err(
        'VALIDATION',
        'Paste what the client actually wrote. An interpretation nobody can see the source of is this system’s opinion about a client.',
      );
    case 'not_shown':
      // §4.9's rule, at its sharpest: checked against the frozen snapshot, so
      // an option revised since the share is not the thing the client saw.
      return err(
        'CONFLICT',
        'That option was not in this round. A client can only choose from what they were actually shown.',
      );
    case 'needs_both':
      return err('VALIDATION', 'A final confirmation has to name the exact theme and the exact colour.');
    case 'needs_selection':
      return err('VALIDATION', 'Say which direction they picked.');
    case 'needs_reference':
      return err('VALIDATION', 'A reference needs a link or a note — something to actually look at.');
    case 'color_not_of_theme':
      return err('VALIDATION', 'That palette belongs to a different direction, so it is not an answer to this one.');
    case 'bad_decision':
      return err('VALIDATION', 'Pick one of the six classifications.');
    case 'unknown_share':
      return err('NOT_FOUND', 'That round does not exist.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record a client decision on this project.');
  }
}

/** §9 — open the round a change request asks for. */
export async function openDesignRevision(input: {
  fromThemeOptionId: string;
  origin: string;
  requestedChanges: string;
  clientDecisionId?: string;
}): Promise<Result<{ revisionId: string | null; escalated: boolean; alreadyOpen: boolean }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('open_design_revision', {
    p_from_theme_option_id: input.fromThemeOptionId,
    p_origin: input.origin,
    p_requested_changes: input.requestedChanges,
    p_client_decision_id: input.clientDecisionId ?? null,
  });
  if (error) return err('INTERNAL', 'Could not open the revision.');

  const row = oneRow<{ outcome?: string; revision_id?: string | null }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'opened':
      return ok({ revisionId: row?.revision_id ?? null, escalated: false, alreadyOpen: false });
    case 'exists':
      // The idempotency key did its job: this client decision already opened a
      // round, and asking twice must not spend another one.
      return ok({ revisionId: row?.revision_id ?? null, escalated: false, alreadyOpen: true });
    case 'escalated':
      // NOT an error. The phase stopped on purpose and a person now has to
      // decide; reporting it as a failure would suggest retrying.
      return ok({ revisionId: null, escalated: true, alreadyOpen: false });
    case 'escalation_open':
      return err(
        'CONFLICT',
        'This project is already waiting on a decision about the revision limit. Nothing more is designed until that is settled.',
      );
    case 'not_a_design_change':
      return err(
        'CONFLICT',
        'That was not a request for a visual change. New functionality goes to the scope process, not to a design round.',
      );
    case 'decision_not_for_this_option':
      return err('CONFLICT', 'That client decision was not about this option.');
    case 'needs_client_decision':
      return err('VALIDATION', 'A client round has to point at what the client said.');
    case 'no_requested_changes':
      return err('VALIDATION', 'Say what has to change, so the designer is not guessing.');
    case 'bad_origin':
      return err('VALIDATION', 'A revision comes from internal review, an Admin edit, or the client.');
    case 'unknown_option':
      return err('NOT_FOUND', 'That theme option does not exist.');
    default:
      return err('FORBIDDEN', 'You do not have permission to open a revision on this project.');
  }
}

/**
 * The completion gate — Master §7.11, §7.12; PM §4.10; Designer §4.9; G-289.
 *
 * The last door in Phase 3 without a caller, and the one whose signature is
 * the point: `lock_phase_three_direction` takes **only the phase**. It reads
 * the client's `final_confirmed` decision to learn what to lock, so this layer
 * has nothing to pass it and nothing to get wrong. A service function that
 * accepted a theme id — even to be helpful — would reintroduce exactly the
 * hole G-285's signature closed.
 *
 * `locked_not_ready` is a SUCCESS. Phase 3 is complete because the client
 * confirmed; the handoff is not Phase 4 ready because the canonical Figma
 * artifact does not exist. Collapsing those into one failure would be the
 * faked completion Designer §26 forbids, inverted — refusing to record
 * something that genuinely happened.
 */
export async function lockPhaseThreeDirection(input: {
  phaseThreeId: string;
}): Promise<Result<{ handoffId: string | null; phaseFourReady: boolean }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('lock_phase_three_direction', {
    p_phase_three_id: input.phaseThreeId,
  });
  if (error) return err('INTERNAL', 'Could not lock the direction.');

  const row = oneRow<{ outcome?: string; handoff_id?: string | null }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'locked':
      return ok({ handoffId: row?.handoff_id ?? null, phaseFourReady: true });
    case 'locked_not_ready':
      return ok({ handoffId: row?.handoff_id ?? null, phaseFourReady: false });
    case 'not_confirmed':
      return err(
        'CONFLICT',
        'The client has not confirmed a final theme and colour yet. A confirmation that cannot be pointed at is the assumption §4.9 forbids.',
      );
    case 'already_locked':
      return err('CONFLICT', 'This direction is already locked. A later change is a new version, not an edit to this one.');
    case 'no_screen_baseline':
      return err('CONFLICT', 'There is no finalized screen baseline, so there is nothing for Phase 4 to build against.');
    case 'theme_not_approved':
      return err('CONFLICT', 'The confirmed option never passed the Admin gate, so it cannot be locked.');
    case 'blocked':
      return err(
        'CONFLICT',
        'This phase is waiting on a person — a blocked requirement, a scope question or the revision limit. Settle that before completing it.',
      );
    case 'unknown_phase':
      return err('NOT_FOUND', 'That phase does not exist.');
    default:
      return err('FORBIDDEN', 'You do not have permission to lock this project’s direction.');
  }
}

/**
 * Representative screens — Designer §7, §17, §19; G-293.
 *
 * G-292's door, given a caller in the unit that follows it rather than five
 * units later. Every refusal it can give is a different thing to fix, and
 * `screen_not_approved` in particular is not the caller's mistake — it is
 * §17 working, and the message says so.
 */
export async function recordRepresentativeScreen(input: {
  themeOptionId: string;
  screenId: string;
  pattern: string;
  figmaNodeId?: string;
  previewAssetUrl?: string;
  decisionNote?: string;
}): Promise<Result<{ sampleId: string | null }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_representative_screen', {
    p_theme_option_id: input.themeOptionId,
    p_screen_id: input.screenId,
    p_pattern: input.pattern,
    p_figma_node_id: input.figmaNodeId ?? null,
    p_preview_asset_url: input.previewAssetUrl ?? null,
    p_decision_note: input.decisionNote ?? null,
  });
  if (error) return err('INTERNAL', 'Could not record the sample screen.');

  const row = oneRow<{ outcome?: string; sample_id?: string | null }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'recorded':
      return ok({ sampleId: row?.sample_id ?? null });
    case 'screen_not_approved':
      // §17 working, not the caller getting it wrong.
      return err(
        'CONFLICT',
        'That screen has not been approved yet. A sample has to stand for a screen somebody signed off — otherwise it is a picture of a screen nobody asked for.',
      );
    case 'already_sampled':
      return err(
        'CONFLICT',
        'This direction already has a sample of that screen. A second one costs a render and settles nothing.',
      );
    case 'direction_locked':
      return err(
        'CONFLICT',
        'This direction is locked. Its samples are the evidence it was judged on, so nothing can be added to them now.',
      );
    case 'nothing_to_show':
      return err('VALIDATION', 'Give a Figma node or a preview — a sample nobody can look at demonstrates nothing.');
    case 'screen_not_in_project':
      return err('CONFLICT', 'That screen belongs to a different project.');
    case 'bad_pattern':
      return err('VALIDATION', 'Say which pattern this sample exposes.');
    case 'unknown_theme':
      return err('NOT_FOUND', 'That theme option does not exist.');
    case 'unknown_screen':
      return err('NOT_FOUND', 'That screen does not exist.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record a sample on this project.');
  }
}

/**
 * A direction's Phase 3 primitives — Designer §4.5, §19, §23; G-296.
 *
 * G-295's two doors, given a caller in the unit that follows them. Null means
 * **unchanged** at the door, so this layer passes `undefined` through rather
 * than coercing a blank field to an empty string — a form that submitted `''`
 * for every untouched input would clear nothing (the door nullifies blanks)
 * but would also defeat the carry-forward the door was fixed to provide.
 */
export async function recordDesignTokenSet(input: {
  themeOptionId: string;
  fontFamilyHeading?: string;
  fontFamilyBody?: string;
  typeScaleRatio?: number;
  baseSpacingPx?: number;
  radiusStyle?: string;
  elevationStyle?: string;
  borderStyle?: string;
  iconTreatment?: string;
  navigationStyle?: string;
  buttonTreatment?: string;
  cardTreatment?: string;
  notes?: string;
}): Promise<Result<{ tokenSetId: string | null }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_design_token_set', {
    p_theme_option_id: input.themeOptionId,
    p_font_family_heading: input.fontFamilyHeading ?? null,
    p_font_family_body: input.fontFamilyBody ?? null,
    p_type_scale_ratio: input.typeScaleRatio ?? null,
    p_base_spacing_px: input.baseSpacingPx ?? null,
    p_radius_style: input.radiusStyle ?? null,
    p_elevation_style: input.elevationStyle ?? null,
    p_border_style: input.borderStyle ?? null,
    p_icon_treatment: input.iconTreatment ?? null,
    p_navigation_style: input.navigationStyle ?? null,
    p_button_treatment: input.buttonTreatment ?? null,
    p_card_treatment: input.cardTreatment ?? null,
    p_notes: input.notes ?? null,
  });
  if (error) return err('INTERNAL', 'Could not record the primitives.');

  const row = oneRow<{ outcome?: string; token_set_id?: string | null }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'recorded':
      return ok({ tokenSetId: row?.token_set_id ?? null });
    case 'says_nothing':
      return err(
        'VALIDATION',
        'Set at least one primitive. A set that says nothing communicates no direction, and Phase 4 would inherit an empty object.',
      );
    case 'unknown_theme':
      return err('NOT_FOUND', 'That theme option does not exist.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record primitives on this project.');
  }
}

/** §19 — freeze them, so Phase 4 inherits a record rather than a promise. */
export async function finalizeDesignTokenSet(input: {
  themeOptionId: string;
}): Promise<Result<{ tokenSetId: string | null; alreadyFinal: boolean }>> {
  const gate = await designActor();
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('finalize_design_token_set', {
    p_theme_option_id: input.themeOptionId,
  });
  if (error) return err('INTERNAL', 'Could not finalize the primitives.');

  const row = oneRow<{ outcome?: string; token_set_id?: string | null }>(data);

  switch (row?.outcome ?? 'no answer') {
    case 'finalized':
      return ok({ tokenSetId: row?.token_set_id ?? null, alreadyFinal: false });
    case 'already_final':
      // Not an error: the caller asked for a state the row is already in.
      return ok({ tokenSetId: row?.token_set_id ?? null, alreadyFinal: true });
    case 'no_draft':
      return err('CONFLICT', 'There are no primitives to finalize for this direction yet.');
    case 'unknown_theme':
      return err('NOT_FOUND', 'That theme option does not exist.');
    default:
      return err('FORBIDDEN', 'You do not have permission to finalize primitives on this project.');
  }
}
