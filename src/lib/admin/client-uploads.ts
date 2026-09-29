import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Recent uploads on a client — SCR-017. The STORED files (a body in the
 * bucket, `storage_path` set) across every project the client has, newest
 * first, beside the linked files `getClient().files` already rolls up. A
 * download goes through the project's own signed-URL route, under the
 * reader's session, so the bucket's policy decides again.
 */
export type ClientUpload = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  category: string;
  version: number;
  sizeBytes: number | null;
  contentType: string | null;
  uploadedAt: string;
  uploadedByEmail: string | null;
  downloadHref: string;
};

export async function listClientUploads(projects: readonly { id: string; name: string }[], limit = 12): Promise<ClientUpload[]> {
  if (projects.length === 0) return [];
  const supabase = await createClient();
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const { data, error } = await supabase
    .schema('projects')
    .from('project_files')
    .select('id, project_id, title, category, version, size_bytes, content_type, created_at, uploaded_by')
    .in('project_id', projects.map((p) => p.id))
    .not('storage_path', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listClientUploads', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.uploaded_by).filter((id): id is string => id !== null))];
  const emailById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, email').in('id', userIds);
    if (usersError) unreadable('listClientUploads.users', usersError);
    for (const u of users ?? []) emailById.set(u.id, u.email);
  }

  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: nameById.get(r.project_id) ?? 'Project',
    title: r.title,
    category: r.category,
    version: r.version,
    sizeBytes: r.size_bytes,
    contentType: r.content_type,
    uploadedAt: r.created_at,
    uploadedByEmail: r.uploaded_by ? (emailById.get(r.uploaded_by) ?? null) : null,
    downloadHref: `/api/projects/${r.project_id}/files/${r.id}/download`,
  }));
}
