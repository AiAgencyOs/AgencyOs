import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { normaliseChips, setProjectClassificationSchema, type SetProjectClassificationInput } from './project-classification-schema';

/** The door of migration 20261005100200. `project.write` here, `core.can_write()` again inside the function. */
export async function setProjectClassification(input: SetProjectClassificationInput): Promise<Result<{ saved: true }>> {
  const parsed = setProjectClassificationSchema.safeParse({ ...input, technology: normaliseChips(input.technology), tags: normaliseChips(input.tags) });
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid project details.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a project.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_project_classification', {
    p_project_id: parsed.data.projectId,
    // The generated argument type has no null; the function takes one to clear the type.
    p_type: parsed.data.type as string,
    p_technology: parsed.data.technology,
    p_tags: parsed.data.tags,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setProjectClassification', detail: error.message }));
    return err('INTERNAL', 'Could not save the project type, technology and tags.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ saved: true });
    case 'invalid_type':
      return err('VALIDATION', 'That project type is not on the list.');
    case 'too_many_technology':
      return err('VALIDATION', 'A project carries at most 12 technologies.');
    case 'too_many_tags':
      return err('VALIDATION', 'A project carries at most 10 tags.');
    case 'chip_too_long':
      return err('VALIDATION', 'A technology or tag is at most 30 characters.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not change a project.');
    default:
      return err('INTERNAL', 'Could not save the project type, technology and tags.');
  }
}
