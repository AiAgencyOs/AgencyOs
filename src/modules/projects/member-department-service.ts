import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setMemberDepartmentSchema, type SetMemberDepartmentInput } from './member-department-schema';

/**
 * The door of migration 20261005100100: an owner or an ops admin sets (or
 * clears) a member's department. `organization.settings` here — the same two
 * roles — and `core.is_admin()` again inside the function.
 */
export async function setMemberDepartment(input: SetMemberDepartmentInput): Promise<Result<{ department: string | null }>> {
  const parsed = setMemberDepartmentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Pick a department from the list.');
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'Only an owner or an ops admin can set a department.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_member_department', {
    p_user_id: parsed.data.userId,
    // The function takes null to clear; the generated argument type is a plain string.
    p_department: parsed.data.department as string,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setMemberDepartment', detail: error.message }));
    return err('INTERNAL', 'Could not save the department.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
    case 'unchanged':
      return ok({ department: parsed.data.department });
    case 'invalid_department':
      return err('VALIDATION', 'That department is not on the list.');
    case 'not_a_member':
      return err('NOT_FOUND', 'That person is not a member of this organisation.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or an ops admin can set a department.');
    default:
      return err('INTERNAL', 'Could not save the department.');
  }
}
