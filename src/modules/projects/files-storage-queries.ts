import 'server-only';

import { createClient } from '@/lib/db/server';
import { probeStorage, type StorageStatus } from '@/lib/files/storage';
import { unreadable } from '@/lib/result';

/**
 * Stored project files — decision 5 of 2026-09-29. Readers for the Files
 * tab: the live files with their versions, the trash, the share links, and
 * whether storage can be reached at all. Every read is under the reader's
 * own RLS; every failure refuses (`unreadable`), never an empty list.
 */

export type { StorageStatus };

export type FileVersion = {
  id: string;
  version: number;
  sizeBytes: number | null;
  contentType: string | null;
  uploadedByName: string | null;
  createdAt: string;
  /** True for a stored object, false for a link (a link has no versions but is drawn the same way). */
  stored: boolean;
  url: string | null;
};

export type ProjectFileHead = {
  id: string;
  category: string;
  title: string;
  description: string | null;
  uploadedByName: string | null;
  createdAt: string;
  /** Link-based file: the external URL. Stored file: null (download goes through the download route). */
  url: string | null;
  stored: boolean;
  /** Newest first. The head row itself is the last entry (version 1). */
  versions: FileVersion[];
  latest: FileVersion;
  shares: FileShare[];
};

export type TrashedFile = {
  id: string;
  title: string;
  category: string;
  version: number;
  deletedAt: string;
  deletedByName: string | null;
  stored: boolean;
};

export type FileShare = {
  id: string;
  fileId: string;
  token: string;
  expiresAt: string;
  revokedAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdByName: string | null;
  createdAt: string;
  /** Live: not revoked and not yet expired, as of the read. */
  live: boolean;
};

type FileRow = {
  id: string;
  category: string;
  title: string;
  url: string | null;
  description: string | null;
  uploaded_by: string | null;
  created_at: string;
  storage_path: string | null;
  size_bytes: number | null;
  content_type: string | null;
  version: number;
  parent_file_id: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
};

const FILE_SELECT =
  'id, category, title, url, description, uploaded_by, created_at, storage_path, size_bytes, content_type, version, parent_file_id, deleted_at, deleted_by';

async function namesFor(userIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', ids);
  if (error) unreadable('files.users', error);
  for (const u of data ?? []) names.set(u.id, u.full_name ?? u.email ?? 'Unknown');
  return names;
}

/**
 * The live files of a project: every first-version row that is not in the
 * trash, with its later versions folded under it, newest first. A version
 * row whose head is trashed is trashed with it (the head carries the
 * trash mark; versions follow their head).
 */
export async function listProjectFileTree(projectId: string): Promise<ProjectFileHead[]> {
  const supabase = await createClient();

  const [{ data, error }, { data: shareRows, error: shareError }] = await Promise.all([
    supabase.schema('projects').from('project_files').select(FILE_SELECT).eq('project_id', projectId).order('created_at', { ascending: false }),
    supabase
      .schema('projects')
      .from('project_file_shares')
      .select('id, file_id, token, expires_at, revoked_at, access_count, last_accessed_at, created_by, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
  ]);
  if (error) unreadable('listProjectFileTree', error);
  if (shareError) unreadable('listProjectFileTree.shares', shareError);

  const rows = (data ?? []) as FileRow[];
  const names = await namesFor([...rows.map((r) => r.uploaded_by), ...(shareRows ?? []).map((s) => s.created_by)]);
  const now = Date.now();

  const sharesByFile = new Map<string, FileShare[]>();
  for (const s of shareRows ?? []) {
    const list = sharesByFile.get(s.file_id) ?? [];
    list.push({
      id: s.id,
      fileId: s.file_id,
      token: s.token,
      expiresAt: s.expires_at,
      revokedAt: s.revoked_at,
      accessCount: s.access_count,
      lastAccessedAt: s.last_accessed_at,
      createdByName: s.created_by ? (names.get(s.created_by) ?? null) : null,
      createdAt: s.created_at,
      live: s.revoked_at === null && new Date(s.expires_at).getTime() > now,
    });
    sharesByFile.set(s.file_id, list);
  }

  const toVersion = (r: FileRow): FileVersion => ({
    id: r.id,
    version: r.version,
    sizeBytes: r.size_bytes,
    contentType: r.content_type,
    uploadedByName: r.uploaded_by ? (names.get(r.uploaded_by) ?? null) : null,
    createdAt: r.created_at,
    stored: r.storage_path !== null,
    url: r.url,
  });

  const heads = rows.filter((r) => r.parent_file_id === null && r.deleted_at === null);
  const versionsByHead = new Map<string, FileRow[]>();
  for (const r of rows) {
    if (r.parent_file_id === null || r.deleted_at !== null) continue;
    const list = versionsByHead.get(r.parent_file_id) ?? [];
    list.push(r);
    versionsByHead.set(r.parent_file_id, list);
  }

  return heads.map((h) => {
    const versions = [...(versionsByHead.get(h.id) ?? []).map(toVersion), toVersion(h)].sort((a, b) => b.version - a.version);
    const latest = versions[0] ?? toVersion(h);
    // A share is drawn under the head whichever version it points at.
    const shares = versions.flatMap((v) => sharesByFile.get(v.id) ?? []);
    return {
      id: h.id,
      category: h.category,
      title: h.title,
      description: h.description,
      uploadedByName: h.uploaded_by ? (names.get(h.uploaded_by) ?? null) : null,
      createdAt: h.created_at,
      url: h.storage_path === null ? h.url : null,
      stored: h.storage_path !== null,
      versions,
      latest,
      shares,
    };
  });
}

/** What is in the trash, newest deletion first. */
export async function listTrashedFiles(projectId: string): Promise<TrashedFile[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_files')
    .select(FILE_SELECT)
    .eq('project_id', projectId)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false });
  if (error) unreadable('listTrashedFiles', error);

  const rows = (data ?? []) as FileRow[];
  const names = await namesFor(rows.map((r) => r.deleted_by));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    version: r.version,
    deletedAt: r.deleted_at as string,
    deletedByName: r.deleted_by ? (names.get(r.deleted_by) ?? null) : null,
    stored: r.storage_path !== null,
  }));
}

/** Whether the configured bucket answers for this organization. Never throws: "not reachable" is a state the page shows. */
export async function readStorageStatus(organizationId: string): Promise<StorageStatus> {
  const supabase = await createClient();
  return probeStorage(supabase, organizationId);
}
