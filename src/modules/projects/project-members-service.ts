import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  addProjectMemberSchema,
  removeProjectMemberSchema,
  setProjectMemberRoleSchema,
  type AddProjectMemberInput,
  type RemoveProjectMemberInput,
  type SetProjectMemberRoleInput,
} from './project-members-schema';

/**
 * Project members — SCR-025's three doors. `project.write` (owner,
 * ops_admin, delivery_lead — the set `project_members_write` names again
 * through `core.can_manage_delivery()`). The audit row is the table's own
 * trigger (`projects.record_stream_fc_change`), so it commits with the
 * change. A trigger also insists the person holds an active internal
 * membership; its refusal is shown verbatim.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

function refusal(message: string): string {
  if (/active internal membership/.test(message)) return 'That person is not an active member of this organisation, so they cannot be put on a project.';
  if (/project_members_project_id_user_id_key|duplicate key/.test(message)) return 'That person is already on this project.';
  return message;
}

export async function addProjectMember(input: AddProjectMemberInput): Promise<Result<{ memberId: string }>> {
  const parsed = addProjectMemberSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid member.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a project’s team.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_members')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      user_id: parsed.data.userId,
      project_role: parsed.data.projectRole,
      added_by: context.userId,
    })
    .select('id')
    .single();
  if (error || !data) {
    log('addProjectMember', error?.message);
    return err(error?.code === '23505' ? 'CONFLICT' : 'INTERNAL', refusal(error?.message ?? 'Could not add the member.'));
  }
  return ok({ memberId: data.id });
}

export async function setProjectMemberRole(input: SetProjectMemberRoleInput): Promise<Result<{ memberId: string }>> {
  const parsed = setProjectMemberRoleSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid role.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a project’s team.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_members')
    .update({ project_role: parsed.data.projectRole })
    .eq('id', parsed.data.memberId)
    .select('id')
    .maybeSingle();
  if (error) {
    log('setProjectMemberRole', error.message);
    return err('INTERNAL', 'Could not change the role.');
  }
  if (!data) return err('NOT_FOUND', 'That member is not visible to you.');
  return ok({ memberId: data.id });
}

export async function removeProjectMember(input: RemoveProjectMemberInput): Promise<Result<{ removed: true }>> {
  const parsed = removeProjectMemberSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid member.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a project’s team.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('project_members').delete().eq('id', parsed.data.memberId).select('id').maybeSingle();
  if (error) {
    log('removeProjectMember', error.message);
    return err('INTERNAL', 'Could not remove the member.');
  }
  if (!data) return err('NOT_FOUND', 'That member is not visible to you.');
  return ok({ removed: true });
}
