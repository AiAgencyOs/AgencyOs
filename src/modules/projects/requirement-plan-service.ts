import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  requirementFileLinkSchema,
  setRequirementPlanSchema,
  type RequirementFileLinkInput,
  type SetRequirementPlanInput,
} from './requirement-plan-schema';

/**
 * The three doors of migration 20261005100300. `task.write` here,
 * `core.can_write()` again inside each function; none of them touches the
 * frozen scope row.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}
const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export async function setRequirementPlan(input: SetRequirementPlanInput): Promise<Result<{ saved: true }>> {
  const parsed = setRequirementPlanSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Pick a priority from the list and an assignee from the team.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to plan a requirement.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_requirement_plan', {
    p_scope_item_id: parsed.data.scopeItemId,
    // The generated argument types have no null; the function takes one for "not set" and "nobody".
    p_priority: parsed.data.priority as string,
    p_assignee_id: parsed.data.assigneeId as string,
  });
  if (error) {
    log('setRequirementPlan', error.message);
    return err('INTERNAL', 'Could not save the priority and assignee.');
  }
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'set':
      return ok({ saved: true });
    case 'invalid_priority':
      return err('VALIDATION', 'Priority is High, Medium or Low.');
    case 'invalid_assignee':
      return err('VALIDATION', 'That person is not an active member of this organisation.');
    case 'not_found':
      return err('NOT_FOUND', 'Requirement not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not plan a requirement.');
    default:
      return err('INTERNAL', 'Could not save the priority and assignee.');
  }
}

export async function linkRequirementFile(input: RequirementFileLinkInput): Promise<Result<{ linked: true }>> {
  const parsed = requirementFileLinkSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Pick one of the project’s files.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to attach a file to a requirement.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('link_requirement_file', { p_scope_item_id: parsed.data.scopeItemId, p_file_id: parsed.data.fileId });
  if (error) {
    log('linkRequirementFile', error.message);
    return err('INTERNAL', 'Could not attach the file.');
  }
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'linked':
      return ok({ linked: true });
    case 'already_linked':
      return err('CONFLICT', 'That file is already attached to this requirement.');
    case 'other_project':
      return err('VALIDATION', 'Only a file of this project can be attached.');
    case 'file_not_found':
      return err('NOT_FOUND', 'That file is not on this project (or is in the trash).');
    case 'not_found':
      return err('NOT_FOUND', 'Requirement not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not attach a file.');
    default:
      return err('INTERNAL', 'Could not attach the file.');
  }
}

export async function unlinkRequirementFile(input: RequirementFileLinkInput): Promise<Result<{ unlinked: true }>> {
  const parsed = requirementFileLinkSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid attachment.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to detach a file from a requirement.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('unlink_requirement_file', { p_scope_item_id: parsed.data.scopeItemId, p_file_id: parsed.data.fileId });
  if (error) {
    log('unlinkRequirementFile', error.message);
    return err('INTERNAL', 'Could not detach the file.');
  }
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'unlinked':
      return ok({ unlinked: true });
    case 'not_linked':
      return err('NOT_FOUND', 'That file is not attached to this requirement.');
    case 'not_found':
      return err('NOT_FOUND', 'Requirement not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not detach a file.');
    default:
      return err('INTERNAL', 'Could not detach the file.');
  }
}
