import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  acknowledgeEscalationSchema,
  escalateBlockerSchema,
  startQaHandoffSchema,
  type AcknowledgeEscalationInput,
  type EscalateBlockerInput,
  type StartQaHandoffInput,
} from './development-events-schema';

/**
 * SCR-039 — the doors that RECORD an escalation and a QA handoff (migration
 * 20261001130000). Escalating is `task.write` (anyone working the task);
 * acknowledging and the handoff are `project.write`, and
 * `projects.start_qa_handoff` is the gate: it refuses, with the counts,
 * while a task is blocked or still todo/in_progress.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function escalateBlocker(input: EscalateBlockerInput): Promise<Result<{ eventId: string }>> {
  const parsed = escalateBlockerSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid escalation.');

  const context = await requireInternal();
  if (!can(context.role, 'task.write')) return err('FORBIDDEN', 'You do not have permission to escalate a blocker.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('escalate_blocker', { p_task_id: parsed.data.taskId, p_reason: parsed.data.reason });
  if (error) {
    log('escalateBlocker', error.message);
    return err('INTERNAL', 'Could not record the escalation.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; event_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'escalated':
      return ok({ eventId: row.event_id ?? '' });
    case 'not_blocked':
      return err('CONFLICT', 'Only a blocked task is escalated. Mark it blocked, with its reason, first.');
    case 'already_open':
      return err('CONFLICT', 'This blocker is already with the PM.');
    case 'no_reason':
      return err('VALIDATION', 'Say why this needs the PM.');
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not escalate.');
    default:
      return err('INTERNAL', 'Could not record the escalation.');
  }
}

export async function acknowledgeEscalation(input: AcknowledgeEscalationInput): Promise<Result<{ acknowledged: true }>> {
  const parsed = acknowledgeEscalationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid escalation.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to acknowledge an escalation.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('acknowledge_escalation', { p_event_id: parsed.data.eventId });
  if (error) {
    log('acknowledgeEscalation', error.message);
    return err('INTERNAL', 'Could not acknowledge the escalation.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'acknowledged':
      return ok({ acknowledged: true });
    case 'not_open':
      return err('CONFLICT', 'This escalation is already acknowledged.');
    case 'not_found':
      return err('NOT_FOUND', 'Escalation not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may acknowledge.');
    default:
      return err('INTERNAL', 'Could not acknowledge the escalation.');
  }
}

export async function startQaHandoff(input: StartQaHandoffInput): Promise<Result<{ eventId: string }>> {
  const parsed = startQaHandoffSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid project.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to start a QA handoff.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('start_qa_handoff', { p_project_id: parsed.data.projectId });
  if (error) {
    log('startQaHandoff', error.message);
    return err('INTERNAL', 'Could not start the handoff.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; event_id?: string | null; blocked?: number | null; not_ready?: number | null } | undefined;
  switch (row?.outcome) {
    case 'started':
      return ok({ eventId: row.event_id ?? '' });
    case 'gate_refused':
      return err(
        'CONFLICT',
        `The handoff gate refused: ${row.blocked ?? 0} blocked task${(row.blocked ?? 0) === 1 ? '' : 's'}, ${row.not_ready ?? 0} still to do or in progress. Every task must be in review or done.`,
      );
    case 'already_open':
      return err('CONFLICT', 'A QA handoff is already open for this project.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may start a handoff.');
    default:
      return err('INTERNAL', 'Could not start the handoff.');
  }
}
