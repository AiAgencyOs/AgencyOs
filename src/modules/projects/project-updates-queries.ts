import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** SCR-019 — the updates sent from this project, newest first. */
export type ProjectUpdate = {
  id: string;
  body: string;
  sentTo: 'client' | 'internal';
  sentByName: string | null;
  conversationId: string | null;
  createdAt: string;
};

export async function listProjectUpdates(projectId: string, limit = 10): Promise<ProjectUpdate[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_updates')
    .select('id, body, sent_to, sent_by, conversation_id, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listProjectUpdates', error);
  const rows = data ?? [];

  const senderIds = [...new Set(rows.map((r) => r.sent_by).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (senderIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', senderIds);
    if (usersError) unreadable('listProjectUpdates.users', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? u.email);
  }

  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    sentTo: r.sent_to as 'client' | 'internal',
    sentByName: r.sent_by ? (names.get(r.sent_by) ?? null) : null,
    conversationId: r.conversation_id,
    createdAt: r.created_at,
  }));
}
