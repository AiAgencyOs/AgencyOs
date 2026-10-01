import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** The overview's Project Notes card (migration 20261004100000): newest first, internal only. */
export type ProjectNote = { id: string; title: string; body: string | null; createdAt: string; createdByName: string | null };

export async function listProjectNotes(projectId: string, limit = 5): Promise<ProjectNote[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_notes')
    .select('id, title, body, created_at, created_by')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listProjectNotes', error);
  const rows = data ?? [];

  const authorIds = [...new Set(rows.map((r) => r.created_by).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name').in('id', authorIds);
    if (usersError) unreadable('listProjectNotes.authors', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? '');
  }
  return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at, createdByName: r.created_by ? (names.get(r.created_by) || null) : null }));
}
