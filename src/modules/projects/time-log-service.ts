import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  addTimeLogSchema,
  deleteTimeLogSchema,
  updateTimeLogSchema,
  type AddTimeLogInput,
  type DeleteTimeLogInput,
  type UpdateTimeLogInput,
} from './time-log-schema';

/**
 * Time log doors — decision 4 of 2026-09-29.
 *
 * `task.write` throughout: logging time against a task is the same class of
 * act as ticking its checklist, and every internal role holds it. The row
 * is always the caller's own (`person_id = auth.uid()`, which
 * `time_logs_insert` RLS insists on again). Edit is own-only; delete is own,
 * or any entry for the roles holding `project.write` (owner, ops_admin,
 * delivery_lead — `core.can_manage_delivery()` says the same at the row).
 * Audit is the table's own trigger, insert, update and delete alike. No
 * billing effect: nothing here touches finance.
 */

function refused(what: string): Result<never> {
  return err('FORBIDDEN', `You do not have permission to ${what}.`);
}

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function addTimeLog(input: AddTimeLogInput): Promise<Result<{ timeLogId: string }>> {
  const parsed = addTimeLogSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid time entry.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('log time');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('time_logs')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      task_id: parsed.data.taskId,
      person_id: context.userId,
      hours: parsed.data.hours,
      logged_on: parsed.data.loggedOn,
      note: parsed.data.note || null,
    })
    .select('id')
    .single();

  if (error || !data) {
    log('addTimeLog', error?.message);
    if (error?.message.includes('not on this project')) return err('VALIDATION', 'That task is not on this project.');
    return err('INTERNAL', 'Could not log the time.');
  }
  return ok({ timeLogId: data.id });
}

export async function updateTimeLog(input: UpdateTimeLogInput): Promise<Result<{ timeLogId: string }>> {
  const parsed = updateTimeLogSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid time entry.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('edit a time entry');

  const supabase = await createClient();
  const { data: row, error: readError } = await supabase
    .schema('projects')
    .from('time_logs')
    .select('id, person_id')
    .eq('id', parsed.data.timeLogId)
    .maybeSingle();
  if (readError) {
    log('updateTimeLog.read', readError.message);
    return err('INTERNAL', 'Could not read the time entry.');
  }
  if (!row) return err('NOT_FOUND', 'Time entry not found.');
  if (row.person_id !== context.userId) return err('FORBIDDEN', 'Only the person who logged an entry can edit it.');

  const { data, error } = await supabase
    .schema('projects')
    .from('time_logs')
    .update({ hours: parsed.data.hours, logged_on: parsed.data.loggedOn, note: parsed.data.note || null })
    .eq('id', row.id)
    .select('id');
  if (error) {
    log('updateTimeLog', error.message);
    return err('INTERNAL', 'Could not save the time entry.');
  }
  if (!data || data.length === 0) return err('FORBIDDEN', 'The database refused the edit.');
  return ok({ timeLogId: row.id });
}

export async function deleteTimeLog(input: DeleteTimeLogInput): Promise<Result<{ deleted: true }>> {
  const parsed = deleteTimeLogSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid time entry.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return refused('delete a time entry');

  const supabase = await createClient();
  const { data: row, error: readError } = await supabase
    .schema('projects')
    .from('time_logs')
    .select('id, person_id')
    .eq('id', parsed.data.timeLogId)
    .maybeSingle();
  if (readError) {
    log('deleteTimeLog.read', readError.message);
    return err('INTERNAL', 'Could not read the time entry.');
  }
  if (!row) return err('NOT_FOUND', 'Time entry not found.');
  if (row.person_id !== context.userId && !can(context, 'project.write')) {
    return err('FORBIDDEN', 'Only the person who logged an entry, or a project lead, can delete it.');
  }

  const { data, error } = await supabase.schema('projects').from('time_logs').delete().eq('id', row.id).select('id');
  if (error) {
    log('deleteTimeLog', error.message);
    return err('INTERNAL', 'Could not delete the time entry.');
  }
  if (!data || data.length === 0) return err('FORBIDDEN', 'The database refused the delete.');
  return ok({ deleted: true });
}
