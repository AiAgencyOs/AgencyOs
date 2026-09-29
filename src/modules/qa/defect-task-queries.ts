import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-047 — the defects linked to one task (`qa.defects.task_id`,
 * 20260929190000), for the task's own page. Refuses rather than answering
 * "no defects" on a failed read, like every QA reader.
 */
export type TaskDefect = {
  id: string;
  title: string;
  severity: string;
  status: string;
  createdAt: string;
};

export async function listDefectsForTask(taskId: string): Promise<TaskDefect[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('qa')
    .from('defects')
    .select('id, title, severity, status, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listDefectsForTask', error);

  return (data ?? []).map((d) => ({ id: d.id, title: d.title, severity: d.severity, status: d.status, createdAt: d.created_at }));
}
