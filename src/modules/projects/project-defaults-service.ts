import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  setDefaultAssigneeSchema,
  unwatchProjectSchema,
  watchProjectSchema,
  type SetDefaultAssigneeInput,
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
  if (!can(context.role, 'project.write')) {
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
  if (userId !== context.userId && !can(context.role, 'project.sign_off')) {
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
        phases: parsed.data.phases,
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
  if (userId !== context.userId && !can(context.role, 'project.sign_off')) {
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
