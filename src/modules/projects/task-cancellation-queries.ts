import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * U1-2 — "the assignee is told": tasks assigned to the caller that somebody else
 * cancelled, with the reason. One read door, `projects.task_cancellations`, over
 * the audit trail (the pattern `projects.schedule_changes` set); the Notifications
 * inbox lists them. A failed read refuses: an empty list is an answer, a database
 * that did not reply is not.
 */
export type TaskCancellation = {
  auditId: number;
  cancelledAt: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  reason: string;
  actorName: string | null;
};

export async function listMyTaskCancellations(opts: { sinceIso?: string; limit?: number } = {}): Promise<TaskCancellation[]> {
  const supabase = await createClient();
  const args: { p_limit: number; p_since?: string } = { p_limit: opts.limit ?? 50 };
  if (opts.sinceIso) args.p_since = opts.sinceIso;
  const { data, error } = await supabase.schema('projects').rpc('task_cancellations', args);
  if (error) unreadable('listMyTaskCancellations', error);
  type Row = { audit_id: number; changed_at: string; task_id: string; task_title: string; project_id: string; project_name: string; reason: string; actor_name: string | null };
  return ((data ?? []) as Row[]).map((r) => ({
    auditId: r.audit_id,
    cancelledAt: r.changed_at,
    taskId: r.task_id,
    taskTitle: r.task_title,
    projectId: r.project_id,
    projectName: r.project_name,
    reason: r.reason,
    actorName: r.actor_name,
  }));
}
