import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { serverEnv } from '@/lib/env';

import type { Database } from '@/lib/db/types';

/**
 * Project files in Supabase Storage — decision 5 of 2026-09-29.
 *
 * The one place the bucket name is read (env `SUPABASE_FILES_BUCKET`,
 * default `project-files`) and the one probe that says whether storage can
 * be reached at all. The local stack has NO storage service, so every
 * control on the Files page is gated on `probeStorage` first: when the
 * answer is "not reachable" the page says so in words and the upload door
 * refuses with the same sentence. Nothing here pretends an upload landed.
 *
 * Object keys are `<organization_id>/<project_id>/<file_id>/<version>-<name>`.
 * The first folder is the tenant, which is what the bucket's RLS policies
 * check (see the migration); the rest keeps every version its own object.
 */

export function filesBucket(): string {
  return serverEnv().SUPABASE_FILES_BUCKET;
}

export type StorageStatus =
  | { reachable: true; bucket: string }
  | { reachable: false; bucket: string; reason: string };

/**
 * Lists one entry under the tenant's own folder. Under the bucket policies
 * an internal reader may do that; a missing bucket, a storage service that
 * is not running, or a network failure all come back as an error, and the
 * error's own words are the reason the page prints.
 *
 * `bucket` defaults to the project-files bucket; the profile page probes the
 * `avatars` bucket under the person's own folder with the same question.
 */
export async function probeStorage(
  supabase: SupabaseClient<Database>,
  folder: string,
  bucket: string = filesBucket(),
): Promise<StorageStatus> {
  try {
    const { error } = await supabase.storage.from(bucket).list(folder, { limit: 1 });
    if (error) return { reachable: false, bucket, reason: describeStorageError(error.message, bucket) };
    return { reachable: true, bucket };
  } catch (e) {
    return { reachable: false, bucket, reason: describeStorageError(e instanceof Error ? e.message : String(e), bucket) };
  }
}

function describeStorageError(message: string, bucket: string): string {
  const m = message.toLowerCase();
  if (m.includes('bucket not found') || m.includes('not found')) {
    return `The bucket "${bucket}" does not exist on this Supabase project. Create it (private) or set SUPABASE_FILES_BUCKET to the bucket that does.`;
  }
  if (m.includes('fetch failed') || m.includes('econnrefused') || m.includes('network') || m.includes('502') || m.includes('503')) {
    return `Storage did not answer (${message}). This stack has no storage service, or it is not running.`;
  }
  return `Storage refused the request: ${message}`;
}

/** A name safe to put in an object key: no slashes, no control characters, bounded. */
export function safeObjectName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'file';
}

export function objectPath(parts: { organizationId: string; projectId: string; fileId: string; version: number; name: string }): string {
  return `${parts.organizationId}/${parts.projectId}/${parts.fileId}/${parts.version}-${safeObjectName(parts.name)}`;
}

/** Signed URLs live this long: enough to start a download, not enough to become a link somebody forwards. */
export const SIGNED_URL_SECONDS = 300;

/** The largest file the upload door accepts — 50 MB, well under what a Server Action body carries comfortably. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
