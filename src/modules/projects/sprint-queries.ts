import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { sprintEnd } from './sprint-schema';

/** A sprint of one project, with how many tasks sit in it and how many of those are done. */
export type SprintRow = {
  id: string;
  name: string;
  startsOn: string;
  lengthDays: number;
  endsOn: string;
  closedAt: string | null;
  tasks: number;
  done: number;
};

/** The project's sprints, newest start first. Two flat reads: the sprints, then the task counts per sprint. */
export async function listProjectSprints(projectId: string): Promise<SprintRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('sprints')
    .select('id, name, starts_on, length_days, closed_at')
    .eq('project_id', projectId)
    .order('starts_on', { ascending: false });
  if (error) unreadable('listProjectSprints', error);
  const sprints = data ?? [];
  if (sprints.length === 0) return [];

  const { data: placed, error: placedError } = await supabase
    .schema('projects')
    .from('tasks')
    .select('sprint_id, status')
    .eq('project_id', projectId)
    .is('archived_at', null)
    .neq('status', 'cancelled')
    .in('sprint_id', sprints.map((s) => s.id));
  if (placedError) unreadable('listProjectSprints.tasks', placedError);

  const counts = new Map<string, { tasks: number; done: number }>();
  for (const t of placed ?? []) {
    if (!t.sprint_id) continue;
    const c = counts.get(t.sprint_id) ?? { tasks: 0, done: 0 };
    c.tasks += 1;
    if (t.status === 'done') c.done += 1;
    counts.set(t.sprint_id, c);
  }
  return sprints.map((s) => ({
    id: s.id,
    name: s.name,
    startsOn: s.starts_on,
    lengthDays: s.length_days,
    endsOn: sprintEnd(s.starts_on, s.length_days),
    closedAt: s.closed_at,
    tasks: counts.get(s.id)?.tasks ?? 0,
    done: counts.get(s.id)?.done ?? 0,
  }));
}
