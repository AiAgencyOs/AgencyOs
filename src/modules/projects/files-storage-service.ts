import 'server-only';

import { randomBytes } from 'node:crypto';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { filesBucket, MAX_UPLOAD_BYTES, objectPath, probeStorage, SIGNED_URL_SECONDS } from '@/lib/files/storage';
import { err, ok, type Result } from '@/lib/result';

import {
  createFileShareSchema,
  restoreProjectFileSchema,
  revokeFileShareSchema,
  trashProjectFileSchema,
  uploadProjectFileSchema,
  type CreateFileShareInput,
  type RestoreProjectFileInput,
  type RevokeFileShareInput,
  type TrashProjectFileInput,
  type UploadProjectFileInput,
} from './files-storage-schema';

/**
 * Stored project files — decision 5 of 2026-09-29.
 *
 * `project.write` throughout, the capability `addProjectFile` already takes,
 * and `project_files_write` / `project_file_shares_write` RLS decide again
 * at the row; the bucket's own policies decide again at the object. Every
 * door probes storage first and refuses with the probe's own sentence when
 * it cannot be reached — an upload that "succeeded" into nowhere is the one
 * outcome this module must never produce. Audit: `project_files` carries
 * `audit_row_change` already (insert and update cover an upload, a new
 * version, a trash and a restore); shares carry their own recorder.
 */

function refused(what: string): Result<never> {
  return err('FORBIDDEN', `You do not have permission to ${what}.`);
}

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function uploadProjectFile(
  input: UploadProjectFileInput,
  file: File | null,
): Promise<Result<{ fileId: string; version: number }>> {
  const parsed = uploadProjectFileSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid upload.');
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) return err('VALIDATION', 'Choose a file to upload.');
  if (file.size > MAX_UPLOAD_BYTES) return err('VALIDATION', `That file is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return refused('upload a file');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const storage = await probeStorage(supabase, context.organizationId);
  if (!storage.reachable) return err('PROVIDER_ERROR', `Storage is not reachable, so nothing was uploaded. ${storage.reason}`);

  // A new version: the parent must be a live first version on this project.
  let version = 1;
  let title = parsed.data.title || file.name;
  let category = parsed.data.category;
  if (parsed.data.parentFileId) {
    const { data: parent, error: parentError } = await supabase
      .schema('projects')
      .from('project_files')
      .select('id, project_id, parent_file_id, deleted_at, title, category')
      .eq('id', parsed.data.parentFileId)
      .maybeSingle();
    if (parentError) {
      log('uploadProjectFile.parent', parentError.message);
      return err('INTERNAL', 'Could not read the file this is a version of.');
    }
    if (!parent || parent.project_id !== parsed.data.projectId) return err('NOT_FOUND', 'The file this is a version of was not found on this project.');
    if (parent.parent_file_id !== null) return err('VALIDATION', 'A version is added to the file itself, not to another version.');
    if (parent.deleted_at !== null) return err('VALIDATION', 'That file is in the trash. Restore it before adding a version.');

    const { data: last, error: lastError } = await supabase
      .schema('projects')
      .from('project_files')
      .select('version')
      .eq('parent_file_id', parent.id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) {
      log('uploadProjectFile.versions', lastError.message);
      return err('INTERNAL', 'Could not read the existing versions.');
    }
    version = (last?.version ?? 1) + 1;
    title = parsed.data.title || parent.title;
    category = parent.category as typeof category;
  }

  // The row's id names the object, so the row is written first with a
  // placeholder path, the object second, then the path — and a failed
  // upload removes the row again so nothing claims a body that never landed.
  const fileId = crypto.randomUUID();
  const path = objectPath({ organizationId: context.organizationId, projectId: parsed.data.projectId, fileId, version, name: file.name });

  const { error: insertError } = await supabase
    .schema('projects')
    .from('project_files')
    .insert({
      id: fileId,
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      category,
      title,
      description: parsed.data.description || null,
      uploaded_by: context.userId,
      storage_path: path,
      size_bytes: file.size,
      content_type: file.type || null,
      version,
      parent_file_id: parsed.data.parentFileId ?? null,
    });
  if (insertError) {
    log('uploadProjectFile.insert', insertError.message);
    return err('INTERNAL', 'Could not record the file.');
  }

  const { error: uploadError } = await supabase.storage.from(filesBucket()).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (uploadError) {
    log('uploadProjectFile.storage', uploadError.message);
    const { error: undoError } = await supabase.schema('projects').from('project_files').delete().eq('id', fileId);
    if (undoError) log('uploadProjectFile.undo', undoError.message);
    return err('PROVIDER_ERROR', `Storage refused the upload, so nothing was saved: ${uploadError.message}`);
  }

  return ok({ fileId, version });
}

/** Soft delete — the trash. A first version takes its versions with it; a single version goes alone. */
export async function trashProjectFile(input: TrashProjectFileInput): Promise<Result<{ trashed: number }>> {
  const parsed = trashProjectFileSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid file.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return refused('move a file to the trash');

  const supabase = await createClient();
  const now = new Date().toISOString();
  const mark = { deleted_at: now, deleted_by: context.userId };

  const { data, error } = await supabase
    .schema('projects')
    .from('project_files')
    .update(mark)
    .eq('id', parsed.data.fileId)
    .is('deleted_at', null)
    .select('id, parent_file_id');
  if (error) {
    log('trashProjectFile', error.message);
    return err('INTERNAL', 'Could not move the file to the trash.');
  }
  if (!data || data.length === 0) return err('NOT_FOUND', 'File not found, or already in the trash.');

  let trashed = data.length;
  if (data[0]?.parent_file_id === null) {
    const { data: versions, error: versionsError } = await supabase
      .schema('projects')
      .from('project_files')
      .update(mark)
      .eq('parent_file_id', parsed.data.fileId)
      .is('deleted_at', null)
      .select('id');
    if (versionsError) {
      log('trashProjectFile.versions', versionsError.message);
      return err('INTERNAL', 'The file was trashed but its versions could not be.');
    }
    trashed += versions?.length ?? 0;
  }
  return ok({ trashed });
}

/** The restore door. A first version brings its versions back; a single version needs its head live. */
export async function restoreProjectFile(input: RestoreProjectFileInput): Promise<Result<{ restored: number }>> {
  const parsed = restoreProjectFileSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid file.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return refused('restore a file');

  const supabase = await createClient();
  const { data: row, error: readError } = await supabase
    .schema('projects')
    .from('project_files')
    .select('id, parent_file_id, deleted_at')
    .eq('id', parsed.data.fileId)
    .maybeSingle();
  if (readError) {
    log('restoreProjectFile.read', readError.message);
    return err('INTERNAL', 'Could not read the file.');
  }
  if (!row || row.deleted_at === null) return err('NOT_FOUND', 'That file is not in the trash.');

  if (row.parent_file_id !== null) {
    const { data: head, error: headError } = await supabase
      .schema('projects')
      .from('project_files')
      .select('deleted_at')
      .eq('id', row.parent_file_id)
      .maybeSingle();
    if (headError) {
      log('restoreProjectFile.head', headError.message);
      return err('INTERNAL', 'Could not read the file this is a version of.');
    }
    if (!head || head.deleted_at !== null) return err('VALIDATION', 'Restore the file itself first; a version cannot stand without it.');
  }

  const clear = { deleted_at: null, deleted_by: null };
  const { data, error } = await supabase.schema('projects').from('project_files').update(clear).eq('id', row.id).select('id');
  if (error) {
    log('restoreProjectFile', error.message);
    return err('INTERNAL', 'Could not restore the file.');
  }
  let restored = data?.length ?? 0;
  if (row.parent_file_id === null) {
    const { data: versions, error: versionsError } = await supabase
      .schema('projects')
      .from('project_files')
      .update(clear)
      .eq('parent_file_id', row.id)
      .not('deleted_at', 'is', null)
      .select('id');
    if (versionsError) {
      log('restoreProjectFile.versions', versionsError.message);
      return err('INTERNAL', 'The file was restored but its versions could not be.');
    }
    restored += versions?.length ?? 0;
  }
  return ok({ restored });
}

/**
 * A share link: 32 random bytes as base64url, an expiry, the maker. The
 * token goes into the URL the public route reads; nothing else about the
 * file is in it. Only a stored, live file can be shared — a linked file
 * already has its own URL, and a trashed one is not on offer.
 */
export async function createFileShareLink(input: CreateFileShareInput): Promise<Result<{ shareId: string; token: string; expiresAt: string }>> {
  const parsed = createFileShareSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid share.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return refused('share a file');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data: file, error: fileError } = await supabase
    .schema('projects')
    .from('project_files')
    .select('id, project_id, storage_path, deleted_at')
    .eq('id', parsed.data.fileId)
    .maybeSingle();
  if (fileError) {
    log('createFileShareLink.file', fileError.message);
    return err('INTERNAL', 'Could not read the file.');
  }
  if (!file) return err('NOT_FOUND', 'File not found.');
  if (file.deleted_at !== null) return err('VALIDATION', 'That file is in the trash.');
  if (file.storage_path === null) return err('VALIDATION', 'Only an uploaded file gets a share link — a linked file already has its own URL.');

  const storage = await probeStorage(supabase, context.organizationId);
  if (!storage.reachable) return err('PROVIDER_ERROR', `Storage is not reachable, so a link would not open. ${storage.reason}`);

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString();

  const { data, error } = await supabase
    .schema('projects')
    .from('project_file_shares')
    .insert({
      organization_id: context.organizationId,
      project_id: file.project_id,
      file_id: file.id,
      token,
      expires_at: expiresAt,
      created_by: context.userId,
    })
    .select('id')
    .single();
  if (error || !data) {
    log('createFileShareLink', error?.message);
    return err('INTERNAL', 'Could not create the share link.');
  }
  return ok({ shareId: data.id, token, expiresAt });
}

export async function revokeFileShareLink(input: RevokeFileShareInput): Promise<Result<{ revoked: true }>> {
  const parsed = revokeFileShareSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid share.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return refused('revoke a share link');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_file_shares')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', parsed.data.shareId)
    .is('revoked_at', null)
    .select('id');
  if (error) {
    log('revokeFileShareLink', error.message);
    return err('INTERNAL', 'Could not revoke the link.');
  }
  if (!data || data.length === 0) return err('NOT_FOUND', 'Share link not found, or already revoked.');
  return ok({ revoked: true });
}

/**
 * A short-lived signed URL for an internal download — the download route's
 * door. Under the reader's own session: RLS on the row and the bucket's
 * select policy both decide.
 */
export async function signedDownloadUrl(fileId: string): Promise<Result<{ url: string; title: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return err('VALIDATION', 'Invalid file.');
  const context = await requireInternal();
  if (!can(context.role, 'project.read')) return refused('read project files');

  const supabase = await createClient();
  const { data: file, error } = await supabase
    .schema('projects')
    .from('project_files')
    .select('id, title, storage_path, deleted_at')
    .eq('id', fileId)
    .maybeSingle();
  if (error) {
    log('signedDownloadUrl.file', error.message);
    return err('INTERNAL', 'Could not read the file.');
  }
  if (!file || file.storage_path === null) return err('NOT_FOUND', 'File not found.');
  if (file.deleted_at !== null) return err('NOT_FOUND', 'That file is in the trash.');

  const { data, error: signError } = await supabase.storage.from(filesBucket()).createSignedUrl(file.storage_path, SIGNED_URL_SECONDS);
  if (signError || !data?.signedUrl) {
    log('signedDownloadUrl.sign', signError?.message);
    return err('PROVIDER_ERROR', `Storage is not reachable, so the file cannot be fetched: ${signError?.message ?? 'no URL was returned'}`);
  }
  return ok({ url: data.signedUrl, title: file.title });
}
