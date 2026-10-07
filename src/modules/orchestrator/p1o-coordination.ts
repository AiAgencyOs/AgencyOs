import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { asRows, firstRow, text, userRpc, whole } from '@/lib/db/p1o-rpc';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { createClient } from '@/lib/db/server';

import { isBoardState, type BoardState } from './p1o-envelope';
import { parseResultEnvelope, type ResultEnvelope } from './p1r-task-state';

/**
 * The workflow task board and its controls (Admin Panel A16/A17, P1-BLUEPRINT-022, P1-COORD-025/026).
 *
 * Reads are database functions that return only the caller's organisation to an internal person; a read that fails is `unreadable`, never an empty board. The
 * controls (pause, resume, reassign, retry, reconcile, escalate, resolve) call the p1o_ doors, which decide who may and say why when they refuse; this module
 * only translates the refusal word into a sentence. Backend state is authoritative: nothing here edits a status.
 */

export type BoardTask = {
  handoffId: string;
  boardState: BoardState;
  status: string;
  priority: string;
  fromAgent: string;
  toAgent: string;
  objective: string;
  subjectType: string | null;
  subjectId: string | null;
  projectId: string | null;
  ageMinutes: number;
  stale: boolean;
  retryCount: number;
  blocker: string | null;
  paused: boolean;
  sideEffectUncertain: boolean;
  waitingOn: number;
  slaAt: string | null;
  correlationId: string;
  createdAt: string;
};

export type BoardFilters = { state?: string | null; agent?: string | null; priority?: string | null; olderThanMinutes?: number | null; staleOnly?: boolean };

export async function readTaskBoard(filters: BoardFilters = {}): Promise<BoardTask[]> {
  const rpc = await userRpc('ai');
  const { data, error } = await rpc('p1o_workflow_task_board', {
    p_state: filters.state && isBoardState(filters.state) ? filters.state : null,
    p_agent: filters.agent || null,
    p_priority: filters.priority || null,
    p_older_than_minutes: filters.olderThanMinutes ?? null,
    p_stale_only: filters.staleOnly === true,
    p_limit: 200,
  });
  if (error) unreadable('readTaskBoard', error);
  return asRows(data).map((r) => ({
    handoffId: String(r.handoff_id),
    boardState: (isBoardState(r.board_state) ? r.board_state : 'created') as BoardState,
    status: String(r.status),
    priority: String(r.priority),
    fromAgent: String(r.from_agent),
    toAgent: String(r.to_agent),
    objective: String(r.objective),
    subjectType: text(r.subject_type),
    subjectId: text(r.subject_id),
    projectId: text(r.project_id),
    ageMinutes: whole(r.age_minutes),
    stale: r.stale === true,
    retryCount: whole(r.retry_count),
    blocker: text(r.blocker),
    paused: r.paused === true,
    sideEffectUncertain: r.side_effect_uncertain === true,
    waitingOn: whole(r.waiting_on),
    slaAt: text(r.sla_at),
    correlationId: String(r.correlation_id),
    createdAt: String(r.created_at),
  }));
}

export type QueueSummaryRow = { boardState: string; tasks: number; oldestAgeMinutes: number; stale: number };

export async function readQueueSummary(): Promise<QueueSummaryRow[]> {
  const rpc = await userRpc('ai');
  const { data, error } = await rpc('p1o_workflow_queue_summary');
  if (error) unreadable('readQueueSummary', error);
  return asRows(data).map((r) => ({ boardState: String(r.board_state), tasks: whole(r.tasks), oldestAgeMinutes: whole(r.oldest_age_minutes), stale: whole(r.stale) }));
}

export type HandoffMetrics = { handoffs: number; completed: number; failed: number; retried: number; escalated: number; blockedNow: number; medianMinutesToComplete: number | null; p90MinutesToComplete: number | null };

export async function readHandoffMetrics(days = 30): Promise<HandoffMetrics | null> {
  const rpc = await userRpc('ai');
  const { data, error } = await rpc('p1o_handoff_metrics', { p_days: days });
  if (error) unreadable('readHandoffMetrics', error);
  const r = firstRow(data);
  if (!r) return null;
  const n = (v: unknown) => (v === null || v === undefined ? null : whole(v));
  return {
    handoffs: whole(r.handoffs), completed: whole(r.completed), failed: whole(r.failed), retried: whole(r.retried), escalated: whole(r.escalated), blockedNow: whole(r.blocked_now),
    medianMinutesToComplete: n(r.median_minutes_to_complete), p90MinutesToComplete: n(r.p90_minutes_to_complete),
  };
}

export async function readHandoffPacket(handoffId: string): Promise<Record<string, unknown> | null> {
  const rpc = await userRpc('ai');
  const { data, error } = await rpc('p1o_handoff_packet', { p_handoff_id: handoffId });
  if (error) unreadable('readHandoffPacket', error);
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** P1-COORD-017: where a task has been, in order, and who moved it. An unreadable history is an error, never "no history". */
export type TaskMove = { from: string | null; to: string; actorKind: 'person' | 'system'; source: string; note: string | null; at: string };
export async function readTaskHistory(handoffId: string): Promise<TaskMove[]> {
  const rpc = await userRpc('ai');
  const { data, error } = await rpc('p1r_handoff_history', { p_handoff_id: handoffId });
  if (error) unreadable('readTaskHistory', error);
  return asRows(data).map((r) => ({
    from: text(r.from_state), to: String(r.to_state), actorKind: r.actor_kind === 'person' ? 'person' : 'system', source: String(r.source), note: text(r.note), at: String(r.at),
  }));
}

/** P1-HANDOFF-012: the unified result envelope of the most recent runs that served a task. Each is parsed against the agreed shape; one that is not is dropped and said so. */
export async function readTaskRunEnvelopes(correlationId: string, toAgent: string, limit = 5): Promise<{ envelopes: ResultEnvelope[]; malformed: number }> {
  const supabase = await createClient();
  const { data: runs, error } = await supabase.schema('ai').from('agent_runs').select('id').eq('correlation_id', correlationId).eq('agent_key', toAgent).order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('readTaskRunEnvelopes', error);
  const rpc = await userRpc('ai');
  const envelopes: ResultEnvelope[] = [];
  let malformed = 0;
  for (const run of runs ?? []) {
    const { data, error: envError } = await rpc('p1r_run_result_envelope', { p_run_id: run.id });
    if (envError) unreadable('readTaskRunEnvelopes.envelope', envError);
    const parsed = parseResultEnvelope(data);
    if (parsed.ok) envelopes.push(parsed.envelope);
    else malformed += 1;
  }
  return { envelopes, malformed };
}

const REFUSAL: Record<string, string> = {
  not_a_door_state: 'That is not a step a person or worker can record.',
  not_the_next_step: 'A task moves one step at a time. Record the next step on the line, not a later one.',
  status_disagrees: 'The task\'s own status does not allow that step yet.',
  person_required: 'Verifying and closing are a signed-in administrator\'s decision.',
  not_on_the_main_line: 'This task is in an exception state. Resolve that first.',
  no_acceptance_criteria: 'A task with no acceptance criteria cannot be marked ready.',
  no_actor: 'This needs a signed-in person.',
  forbidden: 'Only an administrator of this organisation can do that.',
  unknown_handoff: 'That task no longer exists.',
  unknown_escalation: 'That escalation no longer exists.',
  missing_reason: 'A reason is required: it is kept with the task.',
  missing_note: 'A note is required.',
  settled: 'That task is already settled.',
  already_paused: 'It is already paused.',
  not_paused: 'It is not paused.',
  not_queued: 'Only a task nobody has started can be reassigned; cancel and re-create work in flight.',
  same_agent: 'It is already with that agent.',
  not_a_declared_target: 'The registry does not allow that agent to receive this work.',
  not_retryable: 'Only a task whose last attempt failed and may be retried can be retried.',
  reconcile_first: 'The last attempt may have had a real effect. Check what happened and reconcile it before retrying.',
  paused: 'Resume the task first.',
  blocked: 'A prerequisite or a quotation version blocks it.',
  nothing_to_reconcile: 'There is nothing to reconcile.',
  bad_effect: 'Say whether the effect happened or did not.',
  already_resolved: 'That escalation is already resolved.',
  bad_cause: 'That is not an escalation cause.',
  missing_recommendation: 'A recommendation is required.',
};

function say(outcome: string, success: Record<string, string>): Result<string> {
  if (success[outcome]) return ok(success[outcome] as string);
  return err(outcome === 'forbidden' || outcome === 'no_actor' ? 'FORBIDDEN' : 'VALIDATION', REFUSAL[outcome] ?? 'The database refused that.');
}

async function door(fn: string, args: Record<string, unknown>, success: Record<string, string>): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'agent.configure')) return err('FORBIDDEN', 'Only an administrator can change a task.');
  const rpc = await userRpc('ai');
  const { data, error } = await rpc(fn, args);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: fn, detail: error.message }));
    return err('INTERNAL', 'Could not complete that.');
  }
  return say(String(firstRow(data)?.outcome ?? ''), success);
}

export const pauseTask = (handoffId: string, reason: string) => door('p1o_pause_handoff', { p_handoff_id: handoffId, p_reason: reason }, { paused: 'Paused. Nothing will accept or run it until it is resumed.' });
export const resumeTask = (handoffId: string) => door('p1o_resume_handoff', { p_handoff_id: handoffId }, { resumed: 'Resumed.' });
export const reassignTask = (handoffId: string, toAgent: string, reason: string) =>
  door('p1o_reassign_handoff', { p_handoff_id: handoffId, p_to_agent: toAgent, p_reason: reason }, { reassigned: 'Reassigned. The reason is on the task.' });
export const retryTask = (handoffId: string, reason: string) => door('p1o_retry_handoff', { p_handoff_id: handoffId, p_reason: reason }, { retrying: 'Retrying. The previous failure travels with it.' });
export const reconcileTask = (handoffId: string, effect: 'happened' | 'did_not_happen', note: string) =>
  door('p1o_reconcile_handoff', { p_handoff_id: handoffId, p_effect: effect, p_note: note }, { reconciled: 'Reconciled. It can be retried now.' });
export const resolveEscalation = (escalationId: string, note: string) => door('p1o_resolve_handoff_escalation', { p_escalation_id: escalationId, p_note: note }, { resolved: 'Resolved.' });
export const escalateTask = (handoffId: string, recommendation: string) =>
  door('p1o_escalate_handoff', { p_handoff_id: handoffId, p_cause: 'manual', p_recommendation: recommendation, p_attempted_routes: [] }, { escalated: 'Escalated.', already_open: 'It was already escalated for that reason.' });

export const advanceTask = (handoffId: string, toState: string, note: string) =>
  door('p1r_advance_handoff', { p_handoff_id: handoffId, p_to_state: toState, p_note: note || null }, { advanced: 'Recorded. The step is in the task\'s history.' });
