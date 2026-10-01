import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setDeploymentDependencySchema, type SetDeploymentDependencyInput } from './deployment-deps-schema';

/**
 * SCR-049 — `projects.set_release_dependency`. `project.write`, the same
 * capability the smoke checklist and rollback plan use; the door asks
 * `can_manage_delivery()` again and audits. No handover needed.
 */
export async function setDeploymentDependency(input: SetDeploymentDependencyInput): Promise<Result<{ removed: boolean }>> {
  const parsed = setDeploymentDependencySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid dependency.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to edit deployment dependencies.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_release_dependency', {
    p_project_id: parsed.data.projectId,
    p_label: parsed.data.label,
    p_status: parsed.data.status,
    p_remove: parsed.data.remove,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setDeploymentDependency', detail: error.message }));
    return err('INTERNAL', 'Could not update the dependencies.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ removed: false });
    case 'removed':
      return ok({ removed: true });
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'bad_label':
      return err('VALIDATION', 'A dependency needs a name of at most 200 characters.');
    case 'bad_status':
      return err('VALIDATION', 'A dependency is pending or ready.');
    default:
      return err('FORBIDDEN', `The database refused (${row?.outcome ?? 'no answer'}).`);
  }
}
