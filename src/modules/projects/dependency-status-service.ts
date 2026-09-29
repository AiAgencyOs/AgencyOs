import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setDependencyStatusSchema, type SetDependencyStatusInput } from './dependency-status-schema';

/**
 * SCR-043's door — `projects.set_dependency_status`. `project.write`, the
 * capability `addDependency` / `removeDependency` already use for this
 * register, and the function asks `core.can_manage_delivery()` again. The
 * function refuses `unchanged` so a repeat click writes no audit row.
 */
export async function setDependencyStatus(input: SetDependencyStatusInput): Promise<Result<{ status: string }>> {
  const parsed = setDependencyStatusSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to change a dependency.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_dependency_status', {
    p_dependency_id: parsed.data.dependencyId,
    p_status: parsed.data.status,
    p_note: parsed.data.note ?? undefined,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setDependencyStatus', detail: error.message }));
    return err('INTERNAL', 'Could not update the dependency.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ status: parsed.data.status });
    case 'unchanged':
      return err('CONFLICT', `It is already ${parsed.data.status}.`);
    case 'not_found':
      return err('NOT_FOUND', 'Dependency not found.');
    case 'bad_status':
      return err('VALIDATION', 'That is not a dependency status.');
    case 'not_authorized':
    case 'no_actor':
      return err('FORBIDDEN', 'You do not have permission to change a dependency.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'setDependencyStatus', detail: `unrecognised outcome "${String(row?.outcome)}"` }));
      return err('INTERNAL', 'Could not update the dependency.');
  }
}
