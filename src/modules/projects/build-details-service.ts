import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  decidePrototypeAdminSchema,
  recordPrototypeQaSchema,
  sendPrototypeSchema,
  setDeliverableDetailsSchema,
  type DecidePrototypeAdminInput,
  type RecordPrototypeQaInput,
  type SendPrototypeInput,
  type SetDeliverableDetailsInput,
} from './build-details-schema';
import { buildCredentialProblem } from './build-secrets-guard';

/**
 * The three doors on a prototype or build deliverable (migration
 * 20261006400200): its details, Admin's decision on a prototype, and sending
 * a prototype to the client through the QA + Admin gate. `project.write` here
 * (`project.sign_off` for the Admin decision); the database re-checks.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function setDeliverableDetails(input: SetDeliverableDetailsInput): Promise<Result<{ saved: true }>> {
  const parsed = setDeliverableDetailsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid details.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a build.');
  // SCR-043: how a build was made and how to roll it back are read by the whole team; no credential goes in them.
  const credential = buildCredentialProblem([
    { label: 'Commit or ref', value: parsed.data.commitRef },
    { label: 'Build number', value: parsed.data.buildNumber },
    { label: 'How to roll back', value: parsed.data.rollbackNote },
  ]);
  if (credential) return err('VALIDATION', credential);
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_deliverable_details', {
    p_deliverable_id: parsed.data.deliverableId,
    p_platform: parsed.data.platform ?? '',
    p_commit_ref: parsed.data.commitRef,
    p_build_number: parsed.data.buildNumber,
    p_rollback_target_id: parsed.data.rollbackTargetId,
    p_rollback_note: parsed.data.rollbackNote,
  });
  if (error) {
    log('setDeliverableDetails', error.message);
    return err('INTERNAL', 'Could not save the details.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ saved: true });
    case 'not_found':
      return err('NOT_FOUND', 'Build not found.');
    case 'wrong_kind':
      return err('VALIDATION', 'Only a prototype or a build has these details.');
    case 'bad_platform':
      return err('VALIDATION', 'That is not a platform this system knows.');
    case 'bad_rollback_target':
      return err('VALIDATION', 'A rollback target is another build of the same project.');
    case 'too_long':
      return err('VALIDATION', 'A field is too long.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may change a build.');
  }
}

export async function decidePrototypeAdmin(input: DecidePrototypeAdminInput): Promise<Result<{ decision: string }>> {
  const parsed = decidePrototypeAdminSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid decision.');
  const context = await requireInternal();
  if (!can(context, 'project.sign_off')) return err('FORBIDDEN', 'Only an owner or ops admin decides on a prototype.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('decide_prototype_admin', {
    p_deliverable_id: parsed.data.deliverableId,
    p_decision: parsed.data.decision,
    p_note: parsed.data.note,
  });
  if (error) {
    log('decidePrototypeAdmin', error.message);
    return err('INTERNAL', 'Could not record the decision.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'decided':
      return ok({ decision: parsed.data.decision });
    case 'note_required':
      return err('VALIDATION', 'Say what must change.');
    case 'wrong_kind':
      return err('VALIDATION', 'Admin decides on prototypes only.');
    case 'not_found':
      return err('NOT_FOUND', 'Build not found.');
    case 'bad_decision':
      return err('VALIDATION', 'Approve it or ask for changes.');
    case 'too_long':
      return err('VALIDATION', 'A note is at most 1000 characters.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner or ops admin decides on a prototype.');
  }
}

export async function sendPrototypeForClientReview(input: SendPrototypeInput): Promise<Result<{ requestId: string; overridden: boolean }>> {
  const parsed = sendPrototypeSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to send a build to the client.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('send_prototype_for_client_review', {
    p_deliverable_id: parsed.data.deliverableId,
    p_override_reason: parsed.data.overrideReason || undefined,
  });
  if (error) {
    log('sendPrototypeForClientReview', error.message);
    return err('INTERNAL', 'Could not send the build.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; request_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'submitted':
    case 'already_in_review':
      return row.request_id ? ok({ requestId: row.request_id, overridden: Boolean(parsed.data.overrideReason) }) : err('INTERNAL', 'Could not send the build.');
    case 'not_qa_passed':
      return err('CONFLICT', 'Not sent: QA has not passed this build. The normal path needs QA passed and Admin approved.');
    case 'not_admin_approved':
      return err('CONFLICT', 'Not sent: Admin has not approved this build. The normal path needs QA passed and Admin approved.');
    case 'override_not_allowed':
      return err('FORBIDDEN', 'Only the owner may send a build around the gate, and only with a reason.');
    case 'blocked':
      return err('CONFLICT', 'A blocking defect is open against this build, so it cannot go to the client.');
    case 'settled':
      return err('CONFLICT', 'This build is already settled.');
    case 'no_policy':
      return err('CONFLICT', 'No approval policy covers deliverables, so nobody would be named to review this. An owner sets one first.');
    case 'not_found':
      return err('NOT_FOUND', 'Prototype not found.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may send a build.');
  }
}

/** A person's QA verdict on a prototype — a test run cannot name a prototype (Doc 14 §2), so QA is a recorded check with its evidence. */
export async function recordPrototypeQaCheck(input: RecordPrototypeQaInput): Promise<Result<{ outcome: string }>> {
  const parsed = recordPrototypeQaSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid QA check.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to record a QA check.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_prototype_qa_check', {
    p_deliverable_id: parsed.data.deliverableId,
    p_outcome: parsed.data.outcome,
    p_note: parsed.data.note,
    p_evidence_url: parsed.data.evidenceUrl,
  });
  if (error) {
    log('recordPrototypeQaCheck', error.message);
    return err('INTERNAL', 'Could not record the QA check.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'recorded':
      return ok({ outcome: parsed.data.outcome });
    case 'note_required':
      return err('VALIDATION', 'Say what must change.');
    case 'invalid':
      return err('VALIDATION', 'The note or the evidence link is not valid.');
    case 'wrong_kind':
      return err('VALIDATION', 'A QA check is recorded on a prototype.');
    case 'not_found':
      return err('NOT_FOUND', 'Build not found.');
    default:
      return err('FORBIDDEN', 'The database refused: only a writing role records a QA check.');
  }
}
