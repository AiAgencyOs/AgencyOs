import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { rows, parseExceptionStates, parseFutureWork, parseHealth, type PhaseSevenGapsView } from './phase-seven-gaps-parse';

/**
 * What staff see of the Phase 7 derived reads (exception states, linked future work, follow-up tasks, the latest production health snapshot) for one
 * project. Every one is derived or stored by the database; nothing here computes a state. A failed read is surfaced, never shown as an empty list.
 * The latest snapshot always carries its source and age, and `monitoringSourceConfigured` is false: no monitor exists, so a snapshot is a person's note.
 */

type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Rpc = { schema(name: string): { rpc(fn: string, args: Record<string, unknown>): Res; from(table: string): { select(columns: string): { eq(column: string, value: string): Res & { order(column: string, options: { ascending: boolean }): Res } } } } };


export async function loadPhaseSevenGaps(projectId: string): Promise<PhaseSevenGapsView> {
  await requireInternal();
  const projects = ((await createClient()) as unknown as Rpc).schema('projects');
  const [states, future, follow, health] = await Promise.all([
    projects.rpc('p7_exception_states', { p_project_id: projectId }),
    projects.rpc('p7_linked_future_work', { p_project_id: projectId }),
    projects.from('p7d_follow_up_tasks').select('kind, task_id, due_on').eq('project_id', projectId).order('due_on', { ascending: true }),
    projects.rpc('p7_latest_health_snapshot', { p_project_id: projectId }),
  ]);
  if (states.error) unreadable('phase 7 exception states', states.error);
  if (future.error) unreadable('phase 7 linked future work', future.error);
  if (follow.error) unreadable('phase 7 follow-up tasks', follow.error);
  if (health.error) unreadable('phase 7 health snapshot', health.error);
  return {
    exceptionStates: parseExceptionStates(states.data),
    futureWork: parseFutureWork(future.data),
    followUps: rows(follow.data).map((r) => ({ kind: String(r.kind), taskId: String(r.task_id), dueOn: String(r.due_on) })),
    health: parseHealth(health.data),
  };
}
