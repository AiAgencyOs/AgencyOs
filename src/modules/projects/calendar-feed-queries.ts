import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** SCR-022 — the caller's own live feed for a project, if one exists (RLS shows only one's own rows). */
export type MyCalendarFeed = { id: string; token: string; createdAt: string; fetchCount: number; lastFetchedAt: string | null };

export async function readMyCalendarFeed(projectId: string): Promise<MyCalendarFeed | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('calendar_feed_tokens')
    .select('id, token, created_at, fetch_count, last_fetched_at')
    .eq('project_id', projectId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) unreadable('readMyCalendarFeed', error);
  return data ? { id: data.id, token: data.token, createdAt: data.created_at, fetchCount: data.fetch_count, lastFetchedAt: data.last_fetched_at } : null;
}
