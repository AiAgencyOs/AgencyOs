import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** SCR-048 — the suite schedules of one project, or of every project (the QA dashboard). */
export type SuiteScheduleRow = {
  id: string;
  projectId: string;
  deliverableId: string;
  suite: string;
  cron: string;
  active: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
};

export async function listSuiteSchedules(projectId?: string): Promise<SuiteScheduleRow[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('qa')
    .from('suite_schedules')
    .select('id, project_id, deliverable_id, suite, cron, active, next_run_at, last_run_at, last_run_id')
    .order('next_run_at', { ascending: true, nullsFirst: false })
    .limit(500);
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query;
  if (error) unreadable('listSuiteSchedules', error);
  return (data ?? []).map((s) => ({
    id: s.id,
    projectId: s.project_id,
    deliverableId: s.deliverable_id,
    suite: s.suite,
    cron: s.cron,
    active: s.active,
    nextRunAt: s.next_run_at,
    lastRunAt: s.last_run_at,
    lastRunId: s.last_run_id,
  }));
}
