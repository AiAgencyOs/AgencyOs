import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { holdReleaseSchema, liftReleaseHoldSchema, type HoldReleaseInput, type LiftReleaseHoldInput } from './release-hold-schema';

/**
 * SCR-044's two doors — `projects.hold_release` / `projects.lift_release_hold`.
 * `project.sign_off` (owner, ops_admin): the role `markProductionReady`
 * uses, because a hold is that decision's own "no". The functions check
 * `core.is_admin()` again and write audit.audit_log.
 */

function refused(outcome: string | undefined, verb: string): Result<never> {
  switch (outcome) {
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'bad_reason':
      return err('VALIDATION', 'Say why, in at least ten characters.');
    case 'already_held':
      return err('CONFLICT', 'A release hold is already on this project — lift it first to change the reason.');
    case 'not_held':
      return err('CONFLICT', 'There is no release hold on this project.');
    default:
      return err('FORBIDDEN', `You do not have permission to ${verb}.`);
  }
}

export async function holdRelease(input: HoldReleaseInput): Promise<Result<{ held: true }>> {
  const parsed = holdReleaseSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'project.sign_off')) {
    return err('FORBIDDEN', 'You do not have permission to hold a release.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('hold_release', {
    p_project_id: parsed.data.projectId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'holdRelease', detail: error.message }));
    return err('INTERNAL', 'Could not hold the release.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'held') return ok({ held: true });
  return refused(row?.outcome, 'hold a release');
}

export async function liftReleaseHold(input: LiftReleaseHoldInput): Promise<Result<{ lifted: true }>> {
  const parsed = liftReleaseHoldSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'project.sign_off')) {
    return err('FORBIDDEN', 'You do not have permission to lift a release hold.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('lift_release_hold', {
    p_project_id: parsed.data.projectId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'liftReleaseHold', detail: error.message }));
    return err('INTERNAL', 'Could not lift the release hold.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'lifted') return ok({ lifted: true });
  return refused(row?.outcome, 'lift a release hold');
}
