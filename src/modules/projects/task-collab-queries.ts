import 'server-only';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What a task carries besides its own row — SCR-020 / SCR-021 / SCR-041:
 * comments, the checklist (with the ticked share as progress), attached
 * links, and the blocker (`projects.tasks.blocked_reason` / `blocked_at`,
 * migration 20260929140000).
 *
 * Read for a SET of tasks in four bounded queries, not one per task: the
 * Board and My Tasks open their drawers client-side from rows the page
 * already read, so the page reads collaboration for every task it draws
 * and hands each drawer its own slice. Names are resolved once through
 * `core.memberships` → `core.users`, the same route `readTaskDetail` takes.
 */

export {
  emptyTaskCollab,
  type TaskAttachment,
  type TaskChecklistItem,
  type TaskCollab,
  type TaskComment,
} from './task-collab-types';
import { emptyTaskCollab, type TaskCollab } from './task-collab-types';

/** The labels are printed here, through the agency's clock, because the drawers that show them are client components. */
export async function readTaskCollabFor(taskIds: readonly string[], clock: AgencyClock): Promise<Record<string, TaskCollab>> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return {};

  const supabase = await createClient();

  const [tasks, comments, checklist, attachments] = await Promise.all([
    supabase.schema('projects').from('tasks').select('id, blocked_reason, blocked_at').in('id', ids),
    supabase
      .schema('projects')
      .from('task_comments')
      .select('id, task_id, author_id, body, created_at')
      .in('task_id', ids)
      .order('created_at', { ascending: true }),
    supabase
      .schema('projects')
      .from('task_checklist_items')
      .select('id, task_id, label, position, done_at, done_by')
      .in('task_id', ids)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true }),
    supabase
      .schema('projects')
      .from('task_attachments')
      .select('id, task_id, title, url, added_by, created_at')
      .in('task_id', ids)
      .order('created_at', { ascending: true }),
  ]);
  if (tasks.error) unreadable('readTaskCollabFor.tasks', tasks.error);
  if (comments.error) unreadable('readTaskCollabFor.comments', comments.error);
  if (checklist.error) unreadable('readTaskCollabFor.checklist', checklist.error);
  if (attachments.error) unreadable('readTaskCollabFor.attachments', attachments.error);

  const userIds = [
    ...new Set(
      [
        ...(comments.data ?? []).map((c) => c.author_id),
        ...(checklist.data ?? []).map((c) => c.done_by),
        ...(attachments.data ?? []).map((a) => a.added_by),
      ].filter((id): id is string => id !== null),
    ),
  ];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: members, error: membersError } = await supabase
      .schema('core')
      .from('memberships')
      .select('user_id, users:user_id(full_name, email)')
      .in('user_id', userIds);
    if (membersError) unreadable('readTaskCollabFor.people', membersError);
    for (const m of (members ?? []) as { user_id: string; users: { full_name: string | null; email: string } | null }[]) {
      nameById.set(m.user_id, m.users?.full_name ?? m.users?.email ?? 'Unknown');
    }
  }
  const nameOf = (id: string | null) => (id ? (nameById.get(id) ?? 'Unknown') : null);

  const out: Record<string, TaskCollab> = {};
  for (const id of ids) out[id] = emptyTaskCollab(id);

  for (const t of tasks.data ?? []) {
    const entry = out[t.id];
    if (entry) entry.blocked = { reason: t.blocked_reason, at: t.blocked_at, sinceLabel: t.blocked_at ? clock.dateTime(t.blocked_at) : null };
  }
  for (const c of comments.data ?? []) {
    out[c.task_id]?.comments.push({ id: c.id, body: c.body, authorId: c.author_id, authorName: nameOf(c.author_id) ?? 'Unknown', createdAt: c.created_at, createdLabel: clock.dateTime(c.created_at) });
  }
  for (const i of checklist.data ?? []) {
    out[i.task_id]?.checklist.push({ id: i.id, label: i.label, position: i.position, doneAt: i.done_at, doneBy: i.done_by, doneByName: nameOf(i.done_by), doneLabel: i.done_at ? clock.dateTime(i.done_at) : null });
  }
  for (const a of attachments.data ?? []) {
    out[a.task_id]?.attachments.push({ id: a.id, title: a.title, url: a.url, addedByName: nameOf(a.added_by), createdAt: a.created_at, createdLabel: clock.dateTime(a.created_at) });
  }
  for (const entry of Object.values(out)) {
    const total = entry.checklist.length;
    const done = entry.checklist.filter((i) => i.doneAt !== null).length;
    entry.progress = { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
  }
  return out;
}

export async function readTaskCollab(taskId: string, clock: AgencyClock): Promise<TaskCollab> {
  const all = await readTaskCollabFor([taskId], clock);
  return all[taskId] ?? emptyTaskCollab(taskId);
}
