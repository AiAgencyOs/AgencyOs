import 'server-only';

import { readOrgProjectDefaults } from './org-project-defaults-queries';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  setDefaultAssigneeSchema,
  setRoleDefaultAssigneeSchema,
  unwatchProjectSchema,
  watchProjectSchema,
  type SetDefaultAssigneeInput,
  type SetRoleDefaultAssigneeInput,
  type UnwatchProjectInput,
  type WatchProjectInput,
} from './project-defaults-schema';

/**
 * SCR-027's three doors.
 *
 * `setProjectDefaultAssignee` is `project.write` — the same capability that
 * edits the project's own facts — and `projects_write` (can_manage_delivery)
 * decides again. Watching is any internal role for oneself and owner /
 * ops_admin for anybody else, mirrored exactly by `project_watchers_write`,
 * so a delivery lead who names a colleague is refused by the database even
 * if this file were wrong.
 */

export async function setProjectDefaultAssignee(input: SetDefaultAssigneeInput): Promise<Result<{ cleared: boolean }>> {
  const parsed = setDefaultAssigneeSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to set a default assignee.');
  }

  const supabase = await createClient();
  if (parsed.data.defaultAssigneeId) {
    const { data: member, error: memberError } = await supabase
      .schema('core')
      .from('memberships')
      .select('user_id')
      .eq('user_id', parsed.data.defaultAssigneeId)
      .eq('status', 'active')
      .maybeSingle();
    if (memberError) return err('INTERNAL', 'Could not check the roster.');
    if (!member) return err('VALIDATION', 'The default assignee must be an active member of the agency.');
  }

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .update({ default_assignee_id: parsed.data.defaultAssigneeId })
    .eq('id', parsed.data.projectId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setProjectDefaultAssignee', detail: error.message }));
    return err('INTERNAL', 'Could not save the default assignee.');
  }
  if (!data) return err('NOT_FOUND', 'Project not found.');

  return ok({ cleared: parsed.data.defaultAssigneeId === null });
}

export async function watchProject(input: WatchProjectInput): Promise<Result<{ userId: string }>> {
  const parsed = watchProjectSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const userId = parsed.data.userId ?? context.userId;
  if (userId !== context.userId && !can(context, 'project.sign_off')) {
    return err('FORBIDDEN', 'Only the owner or an ops admin may add somebody else as a watcher.');
  }

  const supabase = await createClient();
  if (userId !== context.userId) {
    const { data: member, error: memberError } = await supabase
      .schema('core')
      .from('memberships')
      .select('user_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    if (memberError) return err('INTERNAL', 'Could not check the roster.');
    if (!member) return err('VALIDATION', 'A watcher must be an active member of the agency.');
  }

  const { error } = await supabase
    .schema('projects')
    .from('project_watchers')
    .upsert(
      {
        organization_id: context.organizationId,
        project_id: parsed.data.projectId,
        user_id: userId,
        phases: parsed.data.phases ?? (await readOrgProjectDefaults()).watchPhases,
      },
      { onConflict: 'project_id,user_id' },
    );
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'watchProject', detail: error.message }));
    return err('FORBIDDEN', 'The database refused the watch — check the project exists and you may name this person.');
  }

  return ok({ userId });
}

export async function unwatchProject(input: UnwatchProjectInput): Promise<Result<{ removed: boolean }>> {
  const parsed = unwatchProjectSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  const userId = parsed.data.userId ?? context.userId;
  if (userId !== context.userId && !can(context, 'project.sign_off')) {
    return err('FORBIDDEN', 'Only the owner or an ops admin may remove somebody else as a watcher.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_watchers')
    .delete()
    .eq('project_id', parsed.data.projectId)
    .eq('user_id', userId)
    .select('id');
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'unwatchProject', detail: error.message }));
    return err('INTERNAL', 'Could not remove the watcher.');
  }

  return ok({ removed: (data ?? []).length > 0 });
}

/**
 * Q-B4 — the default assignee of one project role (`projects.project_default_assignees`).
 * `project.write` here; the door `projects.set_project_default_assignee` asks again
 * (owner, ops admin, delivery lead), checks the person is an active internal member and audits.
 */
export async function setProjectRoleDefaultAssignee(input: SetRoleDefaultAssigneeInput): Promise<Result<{ cleared: boolean }>> {
  const parsed = setRoleDefaultAssigneeSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to set a default assignee.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_project_default_assignee', {
    p_project_id: parsed.data.projectId,
    p_project_role: parsed.data.projectRole,
    p_user_id: parsed.data.userId as string,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setProjectRoleDefaultAssignee', detail: error.message }));
    return err('INTERNAL', 'Could not save the default assignee.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ cleared: false });
    case 'cleared':
      return ok({ cleared: true });
    case 'not_internal':
      return err('VALIDATION', 'The default assignee must be an active member of the agency.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'bad_role':
      return err('VALIDATION', 'That is not a project role.');
    default:
      return err('FORBIDDEN', 'The database refused: your role may not set default assignees.');
  }
}
