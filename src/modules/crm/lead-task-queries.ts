import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The tasks that belong to a lead. A task belongs to a project, not to a
 * lead, and the route from a lead to a project is the deal:
 * `sales.opportunities.lead_id` and `projects.projects.opportunity_id`
 * (never `projects.projects.lead_id`, which is a delivery lead, a user). A
 * lead whose deal has not become a project has no tasks, and says so.
 */
export type LeadTask = { id: string; projectId: string; projectName: string; title: string; status: string; priority: string; dueOn: string | null };

export async function listTasksForLead(opportunityId: string | null, limit = 6): Promise<LeadTask[]> {
  if (!opportunityId) return [];
  const supabase = await createClient();

  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .eq('opportunity_id', opportunityId)
    .is('deleted_at', null);
  if (projectsError) unreadable('listTasksForLead.projects', projectsError);
  if (!projects || projects.length === 0) return [];
  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  const { data, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, project_id, title, status, priority, due_on')
    .in('project_id', [...nameById.keys()])
    .neq('status', 'done')
    .order('due_on', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) unreadable('listTasksForLead.tasks', error);

  return (data ?? []).map((t) => ({ id: t.id, projectId: t.project_id, projectName: nameById.get(t.project_id) ?? 'Project', title: t.title, status: t.status, priority: t.priority, dueOn: t.due_on }));
}
