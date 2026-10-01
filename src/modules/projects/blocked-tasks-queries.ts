import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { BLOCKER_TYPE_LABEL, type BlockerType } from './task-blocker';

/**
 * Work that cannot move, across every project the caller may read — the
 * "blockers" SCR-003's inbox names. A blocked task already says what it waits
 * on, who has to act and what happens next (`task-blocker.ts`); this reads
 * those three facts so the inbox can show them instead of a bare count.
 * A finished or cancelled project's old blocks are not asked about.
 *
 * A failed read throws (G-054): "nothing is blocked" is a statement about the
 * business and must not be what a database error looks like.
 */
export type BlockedTaskRow = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  blockerType: string | null;
  blockerTypeLabel: string;
  blockerOwner: string | null;
  nextAction: string | null;
  since: string;
};

const CLOSED_PROJECT = new Set(['completed', 'cancelled', 'archived']);

export async function listBlockedTasks(limit = 25): Promise<BlockedTaskRow[]> {
  const supabase = await createClient();
  const { data: tasks, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, title, project_id, blocker_type, blocker_owner, blocker_next_action, updated_at')
    .eq('status', 'blocked')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listBlockedTasks.tasks', error);
  const rows = tasks ?? [];
  if (rows.length === 0) return [];

  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status')
    .in('id', [...new Set(rows.map((t) => t.project_id))]);
  if (projectsError) unreadable('listBlockedTasks.projects', projectsError);
  const byId = new Map((projects ?? []).map((p) => [p.id, p]));

  return rows
    .filter((t) => {
      const p = byId.get(t.project_id);
      return p !== undefined && !CLOSED_PROJECT.has(p.status);
    })
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.project_id,
      projectName: byId.get(t.project_id)?.name ?? 'Unknown project',
      blockerType: t.blocker_type,
      blockerTypeLabel: t.blocker_type && t.blocker_type in BLOCKER_TYPE_LABEL ? BLOCKER_TYPE_LABEL[t.blocker_type as BlockerType] : 'Reason not recorded',
      blockerOwner: t.blocker_owner,
      nextAction: t.blocker_next_action,
      since: t.updated_at,
    }));
}
