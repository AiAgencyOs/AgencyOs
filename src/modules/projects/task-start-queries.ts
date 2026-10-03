import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { TaskStartCheck } from './task-start-check';

/** Q-C3 — what `projects.task_start_check` says about a task, for the Start Task button. */
export async function readTaskStartCheck(taskId: string): Promise<TaskStartCheck | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('task_start_check', { p_task_id: taskId });
  if (error) unreadable('readTaskStartCheck', error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return { startable: row.startable, requirementOk: row.requirement_ok, openDependencies: row.open_dependencies, reason: row.reason };
}
