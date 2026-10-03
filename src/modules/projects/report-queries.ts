import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-026 — the project report's rows: every task, with the two moments
 * that make a completion trend (`created_at`, `completed_at`) and the
 * status, priority and assignee the CSV export carries. One reader for the
 * page and the export so they can never disagree about what was counted.
 *
 * The date range filters COMPLETIONS, not existence: a task created before
 * `from` and finished inside the window is a completion inside the window.
 * Open tasks come through regardless so the page can say how much is left.
 */
export type ReportTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  moduleId: string | null;
  dueOn: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ReportRange = { from: string; to: string };

export async function listReportTasks(projectId: string, range: ReportRange): Promise<ReportTask[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, title, status, priority, assignee_id, module_id, due_on, created_at, completed_at')
    .eq('project_id', projectId)
    .is('archived_at', null)
    .neq('status', 'cancelled')
    .or(`completed_at.is.null,and(completed_at.gte.${range.from}T00:00:00Z,completed_at.lt.${range.to}T23:59:59.999Z)`)
    .order('created_at', { ascending: true });
  if (error) unreadable('listReportTasks', error);

  return (data ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assigneeId: t.assignee_id,
    moduleId: t.module_id,
    dueOn: t.due_on,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  }));
}

/** ISO week Monday of the day (`YYYY-MM-DD`), computed in UTC on the day key. */
export function weekStartOf(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const lead = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - lead);
  return date.toISOString().slice(0, 10);
}

/** Every week start from `from`'s week to `to`'s week, inclusive. */
export function weeksBetween(from: string, to: string): string[] {
  const weeks: string[] = [];
  let cursor = weekStartOf(from);
  const last = weekStartOf(to);
  while (cursor <= last && weeks.length < 260) {
    weeks.push(cursor);
    const [y, m, d] = cursor.split('-').map(Number) as [number, number, number];
    cursor = new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  }
  return weeks;
}
