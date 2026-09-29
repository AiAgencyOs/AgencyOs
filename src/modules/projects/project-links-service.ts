import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { addProjectLinkSchema, removeProjectLinkSchema, type AddProjectLinkInput, type RemoveProjectLinkInput } from './project-links-schema';

/**
 * Project links — SCR-019's two doors. `project.write`, with
 * `project_links_write` (`core.can_write()`) deciding again at the row;
 * the audit row is the table's trigger.
 */
export async function addProjectLink(input: AddProjectLinkInput): Promise<Result<{ linkId: string }>> {
  const parsed = addProjectLinkSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid link.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to add a project link.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_links')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      label: parsed.data.label,
      url: parsed.data.url,
      kind: parsed.data.kind,
      added_by: context.userId,
    })
    .select('id')
    .single();
  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'addProjectLink', detail: error?.message }));
    return err('INTERNAL', 'Could not add the link.');
  }
  return ok({ linkId: data.id });
}

export async function removeProjectLink(input: RemoveProjectLinkInput): Promise<Result<{ removed: true }>> {
  const parsed = removeProjectLinkSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid link.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to remove a project link.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('project_links').delete().eq('id', parsed.data.linkId).select('id').maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'removeProjectLink', detail: error.message }));
    return err('INTERNAL', 'Could not remove the link.');
  }
  if (!data) return err('NOT_FOUND', 'That link is not visible to you.');
  return ok({ removed: true });
}
