import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { unfreezeScopeVersionSchema, type UnfreezeScopeVersionInput } from './scope-unfreeze-schema';

/**
 * SCR-030 — moves an active baseline back to draft through
 * `projects.unfreeze_scope_version`, the only path the frozen-scope trigger
 * admits for it. Owner only, here (`context.role === 'owner'`, the same gate
 * `decideChangeRequest` uses) and again inside the function
 * (`core.is_owner()`); a reason is required; a later version refuses it.
 * The function writes audit.audit_log with the reason.
 */
export async function unfreezeScopeVersion(input: UnfreezeScopeVersionInput): Promise<Result<{ scopeVersionId: string }>> {
  const parsed = unfreezeScopeVersionSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (context.role !== 'owner') {
    return err('FORBIDDEN', 'Only the owner may unfreeze a scope baseline.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('unfreeze_scope_version', {
    p_version_id: parsed.data.scopeVersionId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'unfreezeScopeVersion', detail: error.message }));
    return err('INTERNAL', 'Could not unfreeze the scope baseline.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'unfrozen':
      return ok({ scopeVersionId: parsed.data.scopeVersionId });
    case 'not_authorized':
    case 'no_actor':
      return err('FORBIDDEN', 'Only the owner may unfreeze a scope baseline.');
    case 'bad_reason':
      return err('VALIDATION', 'Say why, in at least ten characters.');
    case 'not_found':
      return err('NOT_FOUND', 'Scope baseline not found.');
    case 'not_frozen':
      return err('CONFLICT', 'Only an active (frozen) baseline can be unfrozen.');
    case 'later_version_exists':
      return err('CONFLICT', 'A later scope version exists — this baseline is history and stays frozen. Work on the newest version instead.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'unfreezeScopeVersion', detail: `unrecognised outcome "${String(row?.outcome)}"` }));
      return err('INTERNAL', 'Could not unfreeze the scope baseline.');
  }
}
