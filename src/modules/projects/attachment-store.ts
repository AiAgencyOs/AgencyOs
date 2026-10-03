import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/db/types';
import { filesBucket, probeStorage, SIGNED_URL_SECONDS } from '@/lib/files/storage';
import { err, ok, type Result } from '@/lib/result';

import { attachmentObjectPath, attachmentShapeProblem, type AttachmentArea } from './attachment-rules';
import { fileCredentialProblem, SCAN_BYTES, SCANNABLE_TEXT } from './file-secrets-guard';

/**
 * Stores one uploaded file in the project-files bucket under the project-file
 * rules — owner decisions Q-C1, Q-C6 and Q-D3 of 2026-10-01 (a build file, a
 * test-run or bug evidence file, a meeting recording / image / PDF / Word
 * file). The SAME bucket, ceiling, credentials guard and tenant folder the
 * Files tab and the finance proof/receipt upload use (`finance/attachment.ts`
 * is the precedent this follows).
 *
 * Order, so nothing pretends to have landed:
 *   1. the checks that need no storage (size, kind of file, credentials guard);
 *   2. storage is probed, and an unreachable store is said in words;
 *   3. the object is uploaded under `<organization>/<area>/<record id>/<name>`.
 * The caller records the row only after this returns ok, and the database door
 * checks the path again. The bucket grants a person no delete, so an object
 * whose row was then refused stays unreferenced; it is logged.
 *
 * Storage is unreachable on the local stack, so the services that use this are
 * tested with a fake storage client, and the live verifier proves the database
 * half (scripts/verify-r3-files.mjs) and says so.
 *
 * Services import this file lazily (`await import('./attachment-store')`) so
 * nothing that only needs the pure rules ever loads the storage environment.
 */

export type StoredAttachment = { path: string; fileName: string; size: number; contentType: string | null };

export type StoreAttachmentInput = {
  supabase: SupabaseClient<Database>;
  organizationId: string;
  area: AttachmentArea;
  recordId: string;
  file: File;
  /** What the file is called in the refusal's sentence: "build file", "evidence file". */
  noun: string;
};

export async function storeAttachment(input: StoreAttachmentInput): Promise<Result<StoredAttachment>> {
  const { supabase, organizationId, area, recordId, file, noun } = input;

  const shape = attachmentShapeProblem({ name: file.name, size: file.size }, area);
  if (shape) return err('VALIDATION', shape);

  // The credentials guard: the file's name and, for a small text file, its words.
  const text = SCANNABLE_TEXT.test(file.name) || file.type.startsWith('text/') ? await file.slice(0, SCAN_BYTES).text() : null;
  const credential = fileCredentialProblem({ fileName: file.name, text });
  if (credential) return err('VALIDATION', `The ${noun} was not saved. ${credential}`);

  const storage = await probeStorage(supabase, organizationId);
  if (!storage.reachable) return err('PROVIDER_ERROR', `Storage is not reachable, so nothing was uploaded. ${storage.reason}`);

  const path = attachmentObjectPath({ organizationId, area, recordId, name: file.name });
  const { error } = await supabase.storage.from(filesBucket()).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'storeAttachment', area, detail: error.message }));
    return err('PROVIDER_ERROR', `Storage refused the upload, so nothing was saved: ${error.message}`);
  }
  return ok({ path, fileName: file.name.slice(0, 200), size: file.size, contentType: file.type || null });
}

/** A five-minute signed URL for a stored file, under the reader's own session (the bucket's policy decides again at the object). */
export async function signAttachment(supabase: Pick<SupabaseClient<Database>, 'storage'>, path: string): Promise<Result<{ url: string }>> {
  const { data, error } = await supabase.storage.from(filesBucket()).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) {
    return err('PROVIDER_ERROR', `Storage is not reachable, so the file cannot be fetched: ${error?.message ?? 'no URL was returned'}`);
  }
  return ok({ url: data.signedUrl });
}
