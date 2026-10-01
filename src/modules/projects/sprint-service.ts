import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { projectRoleDbProblem } from './project-role-guard';

import {
  closeSprintSchema,
  createSprintSchema,
  placeTaskInSprintSchema,
  type CloseSprintInput,
  type CreateSprintInput,
  type PlaceTaskInSprintInput,
} from './sprint-schema';

/**
 * The three sprint doors of migration 20261005100000. `task.write` here,
 * `core.can_write()` again inside each function; a refusal comes back as a
 * named outcome and is said in words.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export async function createSprint(input: CreateSprintInput): Promise<Result<{ sprintId: string }>> {
  const parsed = createSprintSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid sprint.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to create a sprint.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('create_sprint', {
    p_project_id: parsed.data.projectId,
    p_name: parsed.data.name,
    p_starts_on: parsed.data.startsOn,
    p_length_days: parsed.data.lengthDays,
  });
  if (error) {
    log('createSprint', error.message);
    return err('INTERNAL', 'Could not create the sprint.');
  }
  const row = first<{ outcome?: string; sprint_id?: string | null }>(data);
  switch (row?.outcome) {
    case 'created':
      return row.sprint_id ? ok({ sprintId: row.sprint_id }) : err('INTERNAL', 'Could not create the sprint.');
    case 'overlaps':
      return err('CONFLICT', 'That sprint overlaps another open sprint of this project. Close the other one or start this one after it ends.');
    case 'invalid_name':
      return err('VALIDATION', 'Give the sprint a name of up to 80 characters.');
    case 'invalid_start':
      return err('VALIDATION', 'Pick the first day of the sprint.');
    case 'invalid_length':
      return err('VALIDATION', 'A sprint lasts between 1 and 60 days.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not create a sprint.');
    default:
      return err('INTERNAL', 'Could not create the sprint.');
  }
}

export async function closeSprint(input: CloseSprintInput): Promise<Result<{ closed: true }>> {
  const parsed = closeSprintSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid sprint.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to close a sprint.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('close_sprint', { p_sprint_id: parsed.data.sprintId });
  if (error) {
    log('closeSprint', error.message);
    return err('INTERNAL', 'Could not close the sprint.');
  }
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'closed':
      return ok({ closed: true });
    case 'already_closed':
      return err('CONFLICT', 'That sprint is already closed.');
    case 'not_found':
      return err('NOT_FOUND', 'Sprint not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not close a sprint.');
    default:
      return err('INTERNAL', 'Could not close the sprint.');
  }
}

export async function placeTaskInSprint(input: PlaceTaskInSprintInput): Promise<Result<{ placed: boolean }>> {
  const parsed = placeTaskInSprintSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid task or sprint.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to place a task in a sprint.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('place_task_in_sprint', {
    p_task_id: parsed.data.taskId,
    // The generated argument type has no null; the function takes one.
    p_sprint_id: parsed.data.sprintId as string,
  });
  if (error) {
    log('placeTaskInSprint', error.message);
    const heldProblem = projectRoleDbProblem(error.message);
    if (heldProblem) return err('CONFLICT', heldProblem);
    return err('INTERNAL', 'Could not place the task.');
  }
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'placed':
      return ok({ placed: true });
    case 'removed':
      return ok({ placed: false });
    case 'sprint_closed':
      return err('CONFLICT', 'That sprint is closed. Pick an open sprint.');
    case 'other_project':
      return err('VALIDATION', 'A task can only be placed in a sprint of its own project.');
    case 'sprint_not_found':
      return err('NOT_FOUND', 'Sprint not found.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not change a task.');
    default:
      return err('INTERNAL', 'Could not place the task.');
  }
}
