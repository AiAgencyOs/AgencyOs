import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  setPrototypePlatformSchema,
  submitPrototypeToQaSchema,
  type SetPrototypePlatformInput,
  type SubmitPrototypeToQaInput,
} from './prototype-schema';

/**
 * SCR-037 — the two doors on a prototype artifact (migration
 * 20261001130000). `project.write` here; the functions check the artifact's
 * organisation and `core.can_manage_delivery()` again, the way
 * `record_prototype_build` does.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function setPrototypePlatform(input: SetPrototypePlatformInput): Promise<Result<{ platform: string }>> {
  const parsed = setPrototypePlatformSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That is not a platform this system knows.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a prototype.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_prototype_platform', {
    p_artifact_id: parsed.data.artifactId,
    p_platform: parsed.data.platform,
  });
  if (error) {
    log('setPrototypePlatform', error.message);
    return err('INTERNAL', 'Could not set the platform.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ platform: parsed.data.platform });
    case 'unchanged':
      return err('CONFLICT', `It is already ${parsed.data.platform.replace('_', ' ')}.`);
    case 'not_found':
      return err('NOT_FOUND', 'Prototype build not found.');
    case 'bad_platform':
      return err('VALIDATION', 'That is not a platform this system knows.');
    case 'forbidden':
    case 'no_actor':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may change a prototype.');
    default:
      return err('INTERNAL', 'Could not set the platform.');
  }
}

export async function submitPrototypeToQa(input: SubmitPrototypeToQaInput): Promise<Result<{ submitted: true }>> {
  const parsed = submitPrototypeToQaSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid prototype.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to submit a prototype to QA.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('submit_prototype_to_qa', { p_artifact_id: parsed.data.artifactId });
  if (error) {
    log('submitPrototypeToQa', error.message);
    return err('INTERNAL', 'Could not submit the prototype.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'submitted':
      return ok({ submitted: true });
    case 'already_submitted':
      return err('CONFLICT', 'This build is already with QA.');
    case 'not_found':
      return err('NOT_FOUND', 'Prototype build not found.');
    case 'forbidden':
    case 'no_actor':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may submit a prototype.');
    default:
      return err('INTERNAL', 'Could not submit the prototype.');
  }
}
