import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** SCR-039 — the escalations and QA handoffs recorded on a project (`projects.development_events`). */

export type DevelopmentEvent = {
  id: string;
  projectId: string;
  taskId: string | null;
  kind: 'blocker_escalated' | 'qa_handoff_started';
  reason: string | null;
  detail: Record<string, unknown>;
  status: 'open' | 'acknowledged' | 'closed';
  raisedBy: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  project_id: string;
  task_id: string | null;
  kind: string;
  reason: string | null;
  detail: unknown;
  status: string;
  raised_by: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
};

const SELECT = 'id, project_id, task_id, kind, reason, detail, status, raised_by, acknowledged_by, acknowledged_at, created_at';

const toEvent = (r: Row): DevelopmentEvent => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  kind: r.kind as DevelopmentEvent['kind'],
  reason: r.reason,
  detail: (r.detail ?? {}) as Record<string, unknown>,
  status: r.status as DevelopmentEvent['status'],
  raisedBy: r.raised_by,
  acknowledgedBy: r.acknowledged_by,
  acknowledgedAt: r.acknowledged_at,
  createdAt: r.created_at,
});

export async function listDevelopmentEvents(projectId: string, limit = 30): Promise<DevelopmentEvent[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('development_events')
    .select(SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listDevelopmentEvents', error);
  return ((data ?? []) as Row[]).map(toEvent);
}

/** Open escalations across every project — the Development dashboard's "waiting on the PM" list. */
export async function listOpenEscalations(): Promise<(DevelopmentEvent & { projectName: string; taskTitle: string | null })[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('development_events')
    .select(SELECT)
    .eq('kind', 'blocker_escalated')
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error) unreadable('listOpenEscalations', error);
  const rows = ((data ?? []) as Row[]).map(toEvent);
  if (rows.length === 0) return [];
  const [projects, tasks] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name').in('id', [...new Set(rows.map((r) => r.projectId))]),
    supabase
      .schema('projects')
      .from('tasks')
      .select('id, title')
      .in('id', [...new Set(rows.map((r) => r.taskId).filter((id): id is string => id !== null))]),
  ]);
  if (projects.error) unreadable('listOpenEscalations.projects', projects.error);
  if (tasks.error) unreadable('listOpenEscalations.tasks', tasks.error);
  const nameOf = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const titleOf = new Map((tasks.data ?? []).map((t) => [t.id, t.title]));
  return rows.map((r) => ({ ...r, projectName: nameOf.get(r.projectId) ?? 'a project', taskTitle: r.taskId ? (titleOf.get(r.taskId) ?? null) : null }));
}
