import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-023 — the tasks filed under each payment milestone
 * (`projects.tasks.milestone_id`, the link the schema already carries).
 * One bounded read for the whole project; the Plan page's milestone
 * picker lists the chosen milestone's tasks from it.
 */
export type MilestoneTask = { id: string; milestoneId: string; title: string; status: string; priority: string; assigneeId: string | null; dueOn: string | null };

export async function listTasksByMilestone(projectId: string): Promise<Record<string, MilestoneTask[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, milestone_id, title, status, priority, assignee_id, due_on')
    .eq('project_id', projectId)
    .is('archived_at', null)
    .neq('status', 'cancelled')
    .not('milestone_id', 'is', null)
    .order('created_at', { ascending: true });
  if (error) unreadable('listTasksByMilestone', error);

  const out: Record<string, MilestoneTask[]> = {};
  for (const t of data ?? []) {
    const milestoneId = t.milestone_id as string;
    (out[milestoneId] ??= []).push({ id: t.id, milestoneId, title: t.title, status: t.status, priority: t.priority, assigneeId: t.assignee_id, dueOn: t.due_on });
  }
  return out;
}
