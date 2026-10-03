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
 * ops_admin, delivery_lead). T1-2: every write goes through an audited
 * security-definer door (`projects.add_project_member`,
 * `change_project_member_role`, `remove_project_member`) that re-checks the
 * roster-manager role union, tenancy and the active internal membership;
 * the table has no write policy for a signed-in person any more.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

type DoorRow = { outcome?: string; member_id?: string | null } | undefined;
const first = (data: unknown): DoorRow => (Array.isArray(data) ? data[0] : data) as DoorRow;

/** The sentence for a door outcome that is not a success. */
function doorRefusal(outcome: string | undefined): Result<never> {
  switch (outcome) {
    case 'not_internal':
      return err('VALIDATION', 'That person is not an active member of this organisation, so they cannot be put on a project.');
    case 'already_member':
      return err('CONFLICT', 'That person is already on this project.');
    case 'bad_role':
      return err('VALIDATION', 'Not a project role this system recognises.');
    case 'not_found':
      return err('NOT_FOUND', 'That project or member is not visible to you.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, an ops admin or a delivery lead changes a project’s team.');
  }
}

export async function addProjectMember(input: AddProjectMemberInput): Promise<Result<{ memberId: string }>> {
  const parsed = addProjectMemberSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid member.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a project’s team.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_project_member', {
    p_project_id: parsed.data.projectId,
    p_user_id: parsed.data.userId,
    p_project_role: parsed.data.projectRole,
  });
  if (error) {
    log('addProjectMember', error.message);
    return err('INTERNAL', 'Could not add the member.');
  }
  const row = first(data);
  if (row?.outcome !== 'added' || !row.member_id) return doorRefusal(row?.outcome);
  return ok({ memberId: row.member_id });
}

export async function setProjectMemberRole(input: SetProjectMemberRoleInput): Promise<Result<{ memberId: string }>> {
  const parsed = setProjectMemberRoleSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid role.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a project’s team.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('change_project_member_role', {
    p_member_id: parsed.data.memberId,
    p_project_role: parsed.data.projectRole,
  });
  if (error) {
    log('setProjectMemberRole', error.message);
    return err('INTERNAL', 'Could not change the role.');
  }
  const row = first(data);
  if ((row?.outcome !== 'changed' && row?.outcome !== 'unchanged') || !row.member_id) return doorRefusal(row?.outcome);
  return ok({ memberId: row.member_id });
}

export async function removeProjectMember(input: RemoveProjectMemberInput): Promise<Result<{ removed: true }>> {
  const parsed = removeProjectMemberSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid member.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a project’s team.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('remove_project_member', { p_member_id: parsed.data.memberId });
  if (error) {
    log('removeProjectMember', error.message);
    return err('INTERNAL', 'Could not remove the member.');
  }
  const row = first(data);
  if (row?.outcome !== 'removed') return doorRefusal(row?.outcome);
  return ok({ removed: true });
}
