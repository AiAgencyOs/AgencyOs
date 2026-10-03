import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-025 — what the team has recently done on this project, from the one
 * per-person fact the schema keeps: `projects.tasks` with an assignee, by
 * `updated_at`. A completed task is named as such (its `completed_at` is
 * the moment); anything else is "updated" — the row does not say what
 * changed, and this does not pretend to.
 */
export type TeamActivityEntry = {
  taskId: string;
  title: string;
  status: string;
  assigneeId: string;
  at: string;
  kind: 'completed' | 'updated';
};

export async function listTeamActivity(projectId: string, limit = 25): Promise<TeamActivityEntry[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, title, status, assignee_id, updated_at, completed_at')
    .eq('project_id', projectId)
    .not('assignee_id', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listTeamActivity', error);

  return (data ?? []).map((t) => ({
    taskId: t.id,
    title: t.title,
    status: t.status,
    assigneeId: t.assignee_id as string,
    at: t.status === 'done' && t.completed_at ? t.completed_at : t.updated_at,
    kind: t.status === 'done' && t.completed_at ? 'completed' : 'updated',
  }));
}
