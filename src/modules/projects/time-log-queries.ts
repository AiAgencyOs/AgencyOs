import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Time logs — decision 4 of 2026-09-29. Readers for the task drawer, the
 * task page and the project report: a task's entries with its total, the
 * totals of many tasks at once, and a project's entries grouped per person
 * and per task. Totals come from the three `time_log_totals_*` views the
 * migration defines (security_invoker, so the base table's RLS decides what
 * is counted); entries come from the table. Every failed read refuses.
 */

import { emptyTaskTime, type TaskTime, type TimeLogEntry } from './time-log-types';

export { emptyTaskTime, type TaskTime, type TimeLogEntry };

export type PersonTotal = { personId: string; personName: string; hours: number; entries: number; lastLoggedOn: string | null };
export type TaskTotal = { taskId: string; taskTitle: string; hours: number; entries: number; lastLoggedOn: string | null };

export type ProjectTime = {
  totalHours: number;
  entryCount: number;
  people: PersonTotal[];
  tasks: TaskTotal[];
  entries: TimeLogEntry[];
};

async function namesFor(userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', ids);
  if (error) unreadable('timeLogs.users', error);
  for (const u of data ?? []) names.set(u.id, u.full_name ?? u.email ?? 'Unknown');
  return names;
}

type LogRow = { id: string; task_id: string; person_id: string; hours: number; logged_on: string; note: string | null; created_at: string };

function toEntry(r: LogRow, names: Map<string, string>): TimeLogEntry {
  return {
    id: r.id,
    taskId: r.task_id,
    personId: r.person_id,
    personName: names.get(r.person_id) ?? 'Former member',
    hours: Number(r.hours),
    loggedOn: r.logged_on,
    note: r.note,
    createdAt: r.created_at,
  };
}

/** A set of tasks' entries and totals, keyed by task id — one query for a list of tasks. */
export async function readTaskTimeFor(taskIds: readonly string[]): Promise<Record<string, TaskTime>> {
  const out: Record<string, TaskTime> = {};
  for (const id of taskIds) out[id] = emptyTaskTime(id);
  if (taskIds.length === 0) return out;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('time_logs')
    .select('id, task_id, person_id, hours, logged_on, note, created_at')
    .in('task_id', [...taskIds])
    .order('logged_on', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) unreadable('readTaskTimeFor', error);

  const rows = (data ?? []) as LogRow[];
  const names = await namesFor(rows.map((r) => r.person_id));
  for (const r of rows) {
    const bucket = out[r.task_id] ?? (out[r.task_id] = emptyTaskTime(r.task_id));
    const entry = toEntry(r, names);
    bucket.entries.push(entry);
    bucket.totalHours = Math.round((bucket.totalHours + entry.hours) * 100) / 100;
  }
  return out;
}

export async function readTaskTime(taskId: string): Promise<TaskTime> {
  const all = await readTaskTimeFor([taskId]);
  return all[taskId] ?? emptyTaskTime(taskId);
}

/**
 * A project's time: every entry, and the per-person and per-task totals
 * from the views. Task titles are read so the report can name them; a task
 * that has since been deleted takes its entries with it (cascade), so every
 * total here has a title.
 */
export async function readProjectTime(projectId: string): Promise<ProjectTime> {
  const supabase = await createClient();

  const [entriesRes, peopleRes, tasksRes] = await Promise.all([
    supabase
      .schema('projects')
      .from('time_logs')
      .select('id, task_id, person_id, hours, logged_on, note, created_at')
      .eq('project_id', projectId)
      .order('logged_on', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase.schema('projects').from('time_log_totals_by_person').select('person_id, hours, entries, last_logged_on').eq('project_id', projectId),
    supabase.schema('projects').from('time_log_totals_by_task').select('task_id, hours, entries, last_logged_on').eq('project_id', projectId),
  ]);
  if (entriesRes.error) unreadable('readProjectTime.entries', entriesRes.error);
  if (peopleRes.error) unreadable('readProjectTime.people', peopleRes.error);
  if (tasksRes.error) unreadable('readProjectTime.tasks', tasksRes.error);

  const rows = (entriesRes.data ?? []) as LogRow[];
  const names = await namesFor([...rows.map((r) => r.person_id), ...(peopleRes.data ?? []).map((p) => p.person_id).filter((id): id is string => id !== null)]);

  const taskIds = (tasksRes.data ?? []).map((t) => t.task_id).filter((id): id is string => id !== null);
  const titles = new Map<string, string>();
  if (taskIds.length > 0) {
    const { data: tasks, error } = await supabase.schema('projects').from('tasks').select('id, title').in('id', taskIds);
    if (error) unreadable('readProjectTime.titles', error);
    for (const t of tasks ?? []) titles.set(t.id, t.title);
  }

  const entries = rows.map((r) => toEntry(r, names));
  const totalHours = Math.round(entries.reduce((n, e) => n + e.hours, 0) * 100) / 100;

  const people: PersonTotal[] = (peopleRes.data ?? [])
    .filter((p): p is typeof p & { person_id: string } => p.person_id !== null)
    .map((p) => ({ personId: p.person_id, personName: names.get(p.person_id) ?? 'Former member', hours: Number(p.hours ?? 0), entries: p.entries ?? 0, lastLoggedOn: p.last_logged_on }))
    .sort((a, b) => b.hours - a.hours);

  const tasks: TaskTotal[] = (tasksRes.data ?? [])
    .filter((t): t is typeof t & { task_id: string } => t.task_id !== null)
    .map((t) => ({ taskId: t.task_id, taskTitle: titles.get(t.task_id) ?? 'Untitled task', hours: Number(t.hours ?? 0), entries: t.entries ?? 0, lastLoggedOn: t.last_logged_on }))
    .sort((a, b) => b.hours - a.hours);

  return { totalHours, entryCount: entries.length, people, tasks, entries };
}
