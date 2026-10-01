import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  recordVerificationSchema,
  setRollbackPlanSchema,
  setSmokeItemSchema,
  type RecordVerificationInput,
  type SetRollbackPlanInput,
  type SetSmokeItemInput,
} from './handover-release-schema';

/**
 * SCR-049's doors — `projects.set_release_rollback_plan`,
 * `projects.set_release_smoke_item` and `projects.record_release_verification`
 * (20261006500100), keyed by the PROJECT, so nothing waits for a handover.
 * `project.write`: the roles `core.can_manage_delivery()` admits, and the
 * database asks again. Every one is audited inside the function.
 */

function refused(outcome: string | undefined, verb: string): Result<never> {
  switch (outcome) {
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'bad_label':
      return err('VALIDATION', 'A smoke check needs a name of at most 200 characters.');
    case 'bad_plan':
      return err('VALIDATION', 'A rollback plan is at most 8000 characters.');
    case 'bad_environment':
      return err('VALIDATION', 'Verify against staging, production or other.');
    case 'bad_outcome':
      return err('VALIDATION', 'A verification passed, was partial, or failed.');
    case 'notes_required':
      return err('VALIDATION', 'Say what was found: a partial or failed verification needs notes.');
    case 'bad_url':
      return err('VALIDATION', 'Evidence is a link that starts with http:// or https://.');
    case 'build_not_on_project':
      return err('VALIDATION', 'That build is not on this project.');
    default:
      return err('FORBIDDEN', `You do not have permission to ${verb}.`);
  }
}

export async function setHandoverRollbackPlan(input: SetRollbackPlanInput): Promise<Result<{ cleared: boolean }>> {
  const parsed = setRollbackPlanSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid rollback plan.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to set the rollback plan.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_release_rollback_plan', {
    p_project_id: parsed.data.projectId,
    p_rollback_plan: parsed.data.rollbackPlan,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setHandoverRollbackPlan', detail: error.message }));
    return err('INTERNAL', 'Could not set the rollback plan.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'set') return ok({ cleared: parsed.data.rollbackPlan.length === 0 });
  return refused(row?.outcome, 'set the rollback plan');
}

export async function setHandoverSmokeItem(input: SetSmokeItemInput): Promise<Result<{ removed: boolean }>> {
  const parsed = setSmokeItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid smoke check.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit the smoke checklist.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_release_smoke_item', {
    p_project_id: parsed.data.projectId,
    p_label: parsed.data.label,
    p_done: parsed.data.done,
    p_remove: parsed.data.remove,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setHandoverSmokeItem', detail: error.message }));
    return err('INTERNAL', 'Could not update the smoke checklist.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'set') return ok({ removed: false });
  if (row?.outcome === 'removed') return ok({ removed: true });
  return refused(row?.outcome, 'edit the smoke checklist');
}

/** SCR-049 "Record post-deploy verification": appends a dated verification of the deployed release. */
export async function recordReleaseVerification(input: RecordVerificationInput): Promise<Result<{ verificationId: string }>> {
  const parsed = recordVerificationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid verification.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to record a verification.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_release_verification', {
    p_project_id: parsed.data.projectId,
    p_environment: parsed.data.environment,
    p_outcome: parsed.data.outcome,
    ...(parsed.data.deliverableId ? { p_deliverable_id: parsed.data.deliverableId } : {}),
    ...(parsed.data.notes ? { p_notes: parsed.data.notes } : {}),
    ...(parsed.data.evidenceUrl ? { p_evidence_url: parsed.data.evidenceUrl } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordReleaseVerification', detail: error.message }));
    return err('INTERNAL', 'Could not record the verification.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  if (row?.outcome === 'recorded' && row.id) return ok({ verificationId: row.id });
  return refused(row?.outcome, 'record a verification');
}
