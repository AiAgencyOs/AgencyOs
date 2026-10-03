import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

import type { AttachedSubjectKind } from './attached-files-schema';

/**
 * Reads over `projects.attached_files` (Q-C1, Q-C6) — what a build, a test run
 * or a bug carries, and the signed reference to download one. Rows are read
 * under the caller's session, so RLS (the tenant, internal people only)
 * decides which exist for them; a failed read refuses rather than rendering
 * "no files".
 */

export type AttachedFile = {
  id: string;
  subjectKind: AttachedSubjectKind;
  subjectId: string;
  fileName: string;
  sizeBytes: number;
  contentType: string | null;
  createdAt: string;
};

/** Every attached file of one project, grouped by the record it belongs to. */
export async function listAttachedFiles(projectId: string): Promise<Map<string, AttachedFile[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('attached_files')
    .select('id, subject_kind, subject_id, file_name, size_bytes, content_type, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) unreadable('listAttachedFiles', error);
  const out = new Map<string, AttachedFile[]>();
  for (const r of data ?? []) {
    const list = out.get(r.subject_id) ?? [];
    list.push({
      id: r.id,
      subjectKind: r.subject_kind as AttachedSubjectKind,
      subjectId: r.subject_id,
      fileName: r.file_name,
      sizeBytes: r.size_bytes,
      contentType: r.content_type,
      createdAt: r.created_at,
    });
    out.set(r.subject_id, list);
  }
  return out;
}

/** The five-minute signed URL for one attached file, under the reader's session (the bucket's policy decides again at the object). */
export async function resolveAttachedFileUrl(projectId: string, attachmentId: string): Promise<Result<{ url: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId) || !/^[0-9a-f-]{36}$/i.test(attachmentId)) return err('VALIDATION', 'Invalid file.');
  const context = await requireInternal();
  if (!can(context, 'project.read')) return err('FORBIDDEN', 'You do not have permission to read project files.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('attached_files')
    .select('storage_path')
    .eq('id', attachmentId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolveAttachedFileUrl', detail: error.message }));
    return err('INTERNAL', 'Could not read the file.');
  }
  if (!data) return err('NOT_FOUND', 'No such file on that project.');
  const { signAttachment } = await import('./attachment-store');
  const signed = await signAttachment(supabase, data.storage_path);
  return signed.ok ? ok(signed.data) : signed;
}
