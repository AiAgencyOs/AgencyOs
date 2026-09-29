import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { AnnouncementAudience, AnnouncementStatus } from './announcements-schema';

export type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  status: AnnouncementStatus;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
};

/** Announcements, newest first; filterable by audience and status. RLS scopes to the organization. */
export async function listAnnouncements(filter: { audience?: AnnouncementAudience; status?: AnnouncementStatus; limit?: number } = {}): Promise<AnnouncementRow[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('crm')
    .from('announcements')
    .select('id, title, body, audience, status, published_at, archived_at, created_at')
    .order('created_at', { ascending: false })
    .limit(filter.limit ?? 100);
  if (filter.audience) query = query.eq('audience', filter.audience);
  if (filter.status) query = query.eq('status', filter.status);
  const { data, error } = await query;
  if (error) unreadable('listAnnouncements', error);

  return (data ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    audience: a.audience as AnnouncementAudience,
    status: a.status as AnnouncementStatus,
    publishedAt: a.published_at,
    archivedAt: a.archived_at,
    createdAt: a.created_at,
  }));
}
