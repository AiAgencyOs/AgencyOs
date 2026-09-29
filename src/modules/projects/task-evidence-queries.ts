import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-041 — what a task's "done" points at (`projects.task_evidence`) and
 * the hand-off state the task page reads from `tasks.ready_for_qa_at` and
 * the status. Read only; a failed read refuses.
 */

export type TaskEvidenceEntry = {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  note: string | null;
  submittedBy: string | null;
  createdAt: string;
};

export async function listTaskEvidence(taskId: string): Promise<TaskEvidenceEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('task_evidence')
    .select('id, kind, title, url, note, submitted_by, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listTaskEvidence', error);
  return (data ?? []).map((e) => ({ id: e.id, kind: e.kind, title: e.title, url: e.url, note: e.note, submittedBy: e.submitted_by, createdAt: e.created_at }));
}

export type TaskHandoff = {
  status: string;
  startedAt: string | null;
  readyForQaAt: string | null;
  reopenedCount: number;
  /** The sentence the "Handoff status" row shows. */
  label: 'not started' | 'in progress' | 'blocked' | 'ready for QA' | 'done' | 'reopened';
};

export async function readTaskHandoff(taskId: string): Promise<TaskHandoff | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('status, started_at, ready_for_qa_at, reopened_count')
    .eq('id', taskId)
    .maybeSingle();
  if (error) unreadable('readTaskHandoff', error);
  if (!data) return null;
  const label: TaskHandoff['label'] =
    data.status === 'done'
      ? 'done'
      : data.status === 'blocked'
        ? 'blocked'
        : data.status === 'in_review'
          ? 'ready for QA'
          : data.status === 'in_progress'
            ? data.reopened_count > 0
              ? 'reopened'
              : 'in progress'
            : 'not started';
  return { status: data.status, startedAt: data.started_at, readyForQaAt: data.ready_for_qa_at, reopenedCount: data.reopened_count, label };
}
