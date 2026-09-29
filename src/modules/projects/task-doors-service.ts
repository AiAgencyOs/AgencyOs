import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  reopenTaskFromDefectSchema,
  submitTaskEvidenceSchema,
  taskIdSchema,
  type ReopenTaskFromDefectInput,
  type SubmitTaskEvidenceInput,
  type TaskIdInput,
} from './task-doors-schema';

/**
 * SCR-041 — the four task doors (migration 20261001130000). `task.write`
 * throughout, the capability `setTaskStatus` takes; `core.can_write()` again
 * inside each function. Each is one transition the database checks and
 * audits (task.started, task.ready_for_qa, task.evidence_submitted,
 * task.reopened_from_defect); a refusal is shown in words.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

async function gate(verb: string) {
  const context = await requireInternal();
  if (!can(context.role, 'task.write')) return err('FORBIDDEN', `You do not have permission to ${verb}.`) as Result<never>;
  return null;
}

export async function startTask(input: TaskIdInput): Promise<Result<{ started: true }>> {
  const parsed = taskIdSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid task.');
  const refused = await gate('start a task');
  if (refused) return refused;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('start_task', { p_task_id: parsed.data.taskId });
  if (error) {
    log('startTask', error.message);
    return err('INTERNAL', 'Could not start the task.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'started':
      return ok({ started: true });
    case 'wrong_state':
      return err('CONFLICT', 'Only a task that is still to do can be started.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not change a task.');
    default:
      return err('INTERNAL', 'Could not start the task.');
  }
}

export async function markTaskReadyForQa(input: TaskIdInput): Promise<Result<{ evidenceCount: number }>> {
  const parsed = taskIdSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid task.');
  const refused = await gate('mark a task ready for QA');
  if (refused) return refused;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('mark_task_ready_for_qa', { p_task_id: parsed.data.taskId });
  if (error) {
    log('markTaskReadyForQa', error.message);
    return err('INTERNAL', 'Could not mark the task ready.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; evidence_count?: number | null } | undefined;
  switch (row?.outcome) {
    case 'ready':
      return ok({ evidenceCount: row.evidence_count ?? 0 });
    case 'no_evidence':
      return err('CONFLICT', 'Submit evidence first — a hand-off with nothing to point at is refused.');
    case 'blocked':
      return err('CONFLICT', 'The task is blocked. Unblock it before handing it to QA.');
    case 'wrong_state':
      return err('CONFLICT', 'Only a task in progress can be marked ready for QA.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not change a task.');
    default:
      return err('INTERNAL', 'Could not mark the task ready.');
  }
}

export async function submitTaskEvidence(input: SubmitTaskEvidenceInput): Promise<Result<{ evidenceId: string }>> {
  const parsed = submitTaskEvidenceSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid evidence.');
  const refused = await gate('submit evidence');
  if (refused) return refused;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('submit_task_evidence', {
    p_task_id: parsed.data.taskId,
    p_kind: parsed.data.kind,
    p_title: parsed.data.title,
    p_url: parsed.data.url || undefined,
    p_note: parsed.data.note || undefined,
  });
  if (error) {
    log('submitTaskEvidence', error.message);
    return err('INTERNAL', 'Could not submit the evidence.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; evidence_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'submitted':
      return ok({ evidenceId: row.evidence_id ?? '' });
    case 'nothing_to_point_at':
      return err('VALIDATION', 'Evidence points at something: give a link or a note.');
    case 'bad_kind':
      return err('VALIDATION', 'That is not an evidence kind.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not submit evidence.');
    default:
      return err('INTERNAL', 'Could not submit the evidence.');
  }
}

export async function reopenTaskFromDefect(input: ReopenTaskFromDefectInput): Promise<Result<{ reopened: true }>> {
  const parsed = reopenTaskFromDefectSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid task or defect.');
  const refused = await gate('reopen a task');
  if (refused) return refused;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('reopen_task_from_defect', {
    p_task_id: parsed.data.taskId,
    p_defect_id: parsed.data.defectId,
  });
  if (error) {
    log('reopenTaskFromDefect', error.message);
    return err('INTERNAL', 'Could not reopen the task.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'reopened':
      return ok({ reopened: true });
    case 'defect_not_on_task':
      return err('VALIDATION', 'That defect is not triaged against this task.');
    case 'defect_not_open':
      return err('CONFLICT', 'That defect is already settled; only an open defect reopens a task.');
    case 'wrong_state':
      return err('CONFLICT', 'Only a task in review or done can be reopened.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not change a task.');
    default:
      return err('INTERNAL', 'Could not reopen the task.');
  }
}
