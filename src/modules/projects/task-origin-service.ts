import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { markTaskAgentSchema, verifyAgentTaskSchema, type MarkTaskAgentInput, type VerifyAgentTaskInput } from './task-origin-schema';

/** The two agent-work doors of migration 20261006200000. `task.write` here, `core.can_write()` again inside, audited there. */

const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;
const log = (scope: string, detail: string | undefined) => console.error(JSON.stringify({ level: 'error', scope, detail }));

export async function markTaskAgentGenerated(input: MarkTaskAgentInput): Promise<Result<{ agent: boolean }>> {
  const parsed = markTaskAgentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid task.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to change a task.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('mark_task_agent_generated', { p_task_id: parsed.data.taskId, p_agent: parsed.data.agent });
  if (error) {
    log('markTaskAgentGenerated', error.message);
    return err('INTERNAL', 'Could not change the task’s origin.');
  }
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'set':
    case 'unchanged':
      return ok({ agent: parsed.data.agent });
    case 'already_done':
      return err('CONFLICT', 'The task is already done, so it cannot be marked as agent work now.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not change a task.');
    default:
      return err('INTERNAL', 'Could not change the task’s origin.');
  }
}

export async function verifyAgentTask(input: VerifyAgentTaskInput): Promise<Result<{ verified: true }>> {
  const parsed = verifyAgentTaskSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Say what you checked.');
  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to verify a task.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('verify_agent_task', { p_task_id: parsed.data.taskId, p_note: parsed.data.note });
  if (error) {
    log('verifyAgentTask', error.message);
    return err('INTERNAL', 'Could not verify the task.');
  }
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'verified':
      return ok({ verified: true });
    case 'already_verified':
      return err('CONFLICT', 'This task has already been verified.');
    case 'not_agent_work':
      return err('CONFLICT', 'Only agent-generated work needs verifying.');
    case 'note_required':
      return err('VALIDATION', 'Say what you checked.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not verify a task.');
    default:
      return err('INTERNAL', 'Could not verify the task.');
  }
}
