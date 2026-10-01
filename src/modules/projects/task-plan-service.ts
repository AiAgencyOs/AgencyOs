import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { createTask, setTaskStatus } from './service';
import { projectRoleDbProblem } from './project-role-guard';
import { ARCHIVED_READ_ONLY_MESSAGE, archivedTaskProblem } from './task-transitions';
import {
  addMyTaskSchema,
  addProjectNoteSchema,
  addSubtaskSchema,
  removeProjectNoteSchema,
  setTaskLabelsSchema,
  type AddMyTaskInput,
  type AddProjectNoteInput,
  type AddSubtaskInput,
  type RemoveProjectNoteInput,
  type SetTaskLabelsInput,
} from './task-plan-schema';

/**
 * The doors of migration 20261004100000: add a subtask, label a task, keep a
 * project note. `task.write` in the service, `core.can_write()` again inside
 * each function; a refusal comes back as a named outcome and is said in words.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

async function gate(verb: string) {
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', `You do not have permission to ${verb}.`) as Result<never>;
  return null;
}

export async function addSubtask(input: AddSubtaskInput): Promise<Result<{ taskId: string }>> {
  const parsed = addSubtaskSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid subtask.');
  const refused = await gate('add a subtask');
  if (refused) return refused;

  const supabase = await createClient();
  // V1-1: nothing is added under an archived task.
  const { data: parent } = await supabase.schema('projects').from('tasks').select('archived_at').eq('id', parsed.data.parentTaskId).maybeSingle();
  const archivedProblem = archivedTaskProblem(parent as { archived_at?: string | null } | null);
  if (archivedProblem) return err('CONFLICT', archivedProblem);

  const { data, error } = await supabase.schema('projects').rpc('add_subtask', {
    p_parent_id: parsed.data.parentTaskId,
    p_title: parsed.data.title,
    ...(parsed.data.dueOn ? { p_due_on: parsed.data.dueOn } : {}),
    ...(parsed.data.assigneeId ? { p_assignee_id: parsed.data.assigneeId } : {}),
  });
  if (error) {
    log('addSubtask', error.message);
    const heldProblem = projectRoleDbProblem(error.message);
    if (heldProblem) return err('CONFLICT', heldProblem);
    return err('INTERNAL', 'Could not add the subtask.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; task_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'added':
      return row.task_id ? ok({ taskId: row.task_id }) : err('INTERNAL', 'Could not add the subtask.');
    case 'task_archived_read_only':
      return err('CONFLICT', ARCHIVED_READ_ONLY_MESSAGE);
    case 'nested':
      return err('CONFLICT', 'A subtask cannot have subtasks of its own.');
    case 'invalid_title':
      return err('VALIDATION', 'A subtask needs a title of up to 200 characters.');
    case 'invalid_assignee':
      return err('VALIDATION', 'That person is not a member of this organisation.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not change a task.');
    default:
      return err('INTERNAL', 'Could not add the subtask.');
  }
}

export async function setTaskLabels(input: SetTaskLabelsInput): Promise<Result<{ labels: string[] }>> {
  const parsed = setTaskLabelsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid labels.');
  const refused = await gate('label a task');
  if (refused) return refused;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_task_labels', { p_task_id: parsed.data.taskId, p_labels: parsed.data.labels });
  if (error) {
    log('setTaskLabels', error.message);
    const heldProblem = projectRoleDbProblem(error.message);
    if (heldProblem) return err('CONFLICT', heldProblem);
    return err('INTERNAL', 'Could not save the labels.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; labels?: string[] | null } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ labels: row.labels ?? [] });
    case 'too_many':
      return err('VALIDATION', 'A task carries at most eight labels.');
    case 'label_too_long':
      return err('VALIDATION', 'A label is at most 24 characters.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not change a task.');
    default:
      return err('INTERNAL', 'Could not save the labels.');
  }
}

export async function addProjectNote(input: AddProjectNoteInput): Promise<Result<{ noteId: string }>> {
  const parsed = addProjectNoteSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid note.');
  const refused = await gate('add a project note');
  if (refused) return refused;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_project_note', {
    p_project_id: parsed.data.projectId,
    p_title: parsed.data.title,
    ...(parsed.data.body ? { p_body: parsed.data.body } : {}),
  });
  if (error) {
    log('addProjectNote', error.message);
    return err('INTERNAL', 'Could not add the note.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; note_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'added':
      return row.note_id ? ok({ noteId: row.note_id }) : err('INTERNAL', 'Could not add the note.');
    case 'invalid_title':
      return err('VALIDATION', 'Give the note a title of up to 160 characters.');
    case 'invalid_body':
      return err('VALIDATION', 'A note is at most 4,000 characters.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not add a note.');
    default:
      return err('INTERNAL', 'Could not add the note.');
  }
}

export async function removeProjectNote(input: RemoveProjectNoteInput): Promise<Result<{ removed: true }>> {
  const parsed = removeProjectNoteSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid note.');
  const refused = await gate('remove a project note');
  if (refused) return refused;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('remove_project_note', { p_note_id: parsed.data.noteId });
  if (error) {
    log('removeProjectNote', error.message);
    return err('INTERNAL', 'Could not remove the note.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'removed':
      return ok({ removed: true });
    case 'not_found':
      return err('NOT_FOUND', 'That note is not visible to you.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not remove a note.');
    default:
      return err('INTERNAL', 'Could not remove the note.');
  }
}

/**
 * A task for the person asking, from My tasks: created through the same
 * `createTask` door as everywhere else (assigned to the caller), then moved to
 * the column's status through `setTaskStatus` — no second writer.
 */
export async function addMyTask(input: AddMyTaskInput): Promise<Result<{ taskId: string }>> {
  const parsed = addMyTaskSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid task.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to add a task.');

  const created = await createTask({ projectId: parsed.data.projectId, title: parsed.data.title, ...(parsed.data.dueOn ? { dueOn: parsed.data.dueOn } : {}), assigneeId: context.userId });
  if (!created.ok) return created;
  if (parsed.data.status !== 'todo') {
    const moved = await setTaskStatus({ taskId: created.data.taskId, status: parsed.data.status });
    if (!moved.ok) return err(moved.error.code, `The task was added, but could not be moved: ${moved.error.message}`);
  }
  return ok({ taskId: created.data.taskId });
}
