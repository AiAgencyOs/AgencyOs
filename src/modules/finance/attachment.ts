import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/db/types';
import { filesBucket, MAX_UPLOAD_BYTES, probeStorage, safeObjectName, SIGNED_URL_SECONDS } from '@/lib/files/storage';
import { err, ok, type Result } from '@/lib/result';
import { fileCredentialProblem, SCAN_BYTES, SCANNABLE_TEXT } from '@/modules/projects/file-secrets-guard';

/**
 * An uploaded payment proof or expense receipt — owner decision 5 of
 * 2026-10-01: "Upload allowed, under the project file rules and credentials
 * guard; links still allowed."
 *
 * The SAME rules as a project file, because it is the same bucket and the
 * same promise: the 50 MB limit, the credentials guard over the file's name
 * and (for a small text file) its contents, storage probed first so nothing
 * pretends to have landed, and the object keyed under the tenant's own
 * folder, which is what the bucket's policy checks:
 *
 *   <organization_id>/finance/<kind>/<record id>/<safe file name>
 *
 * The record id is chosen BEFORE the object is stored, and the row is written
 * second, carrying the path: an upload that failed leaves no row claiming a
 * body, and a row that failed leaves only an unreferenced object (the bucket
 * grants no delete to a person, so it cannot be tidied from here; it is
 * named in the log). The row stores the PATH and the file's name, never bytes.
 *
 * Storage is unreachable on the local stack, so this is verified with a fake
 * storage client (tests/finance-attachments.test.ts), not the browser.
 */

export type FinanceAttachmentKind = 'claim-proof' | 'expense-receipt';

const NOUN: Record<FinanceAttachmentKind, string> = { 'claim-proof': 'proof', 'expense-receipt': 'receipt' };

export function financeObjectPath(parts: { organizationId: string; kind: FinanceAttachmentKind; recordId: string; name: string }): string {
  return `${parts.organizationId}/finance/${parts.kind}/${parts.recordId}/${safeObjectName(parts.name)}`;
}

/** Whether a file was actually chosen: a form with an empty file input posts a zero-byte File. */
export function hasChosenFile(file: unknown): file is File {
  return typeof File !== 'undefined' && file instanceof File && file.size > 0;
}

/** The checks that need no storage: size, then the credentials guard. Null when the file may be filed. */
export async function attachmentProblem(file: File, kind: FinanceAttachmentKind): Promise<string | null> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That file is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
  }
  const text = SCANNABLE_TEXT.test(file.name) || file.type.startsWith('text/') ? await file.slice(0, SCAN_BYTES).text() : null;
  const credential = fileCredentialProblem({ fileName: file.name, text });
  if (credential) return `The ${NOUN[kind]} was not saved. ${credential}`;
  return null;
}

type StorageClient = Pick<SupabaseClient<Database>, 'storage'>;

export type StoredAttachment = { path: string; fileName: string };

/**
 * Checks and stores one attachment. Returns the path to write on the row.
 * `supabase` is the caller's own session client: the bucket's insert policy
 * decides again at the object.
 */
export type StoreFinanceAttachmentInput = {
  supabase: SupabaseClient<Database>;
  organizationId: string;
  kind: FinanceAttachmentKind;
  recordId: string;
  file: File;
};

export async function storeFinanceAttachment(input: StoreFinanceAttachmentInput): Promise<Result<StoredAttachment>> {
  const { supabase, organizationId, kind, recordId, file } = input;
  if (file.size === 0) return err('VALIDATION', 'Choose a file to upload.');
  const problem = await attachmentProblem(file, kind);
  if (problem) return err('VALIDATION', problem);

  const storage = await probeStorage(supabase, organizationId);
  if (!storage.reachable) return err('PROVIDER_ERROR', `Storage is not reachable, so nothing was uploaded. ${storage.reason}`);

  const path = financeObjectPath({ organizationId, kind, recordId, name: file.name });
  const { error } = await supabase.storage.from(filesBucket()).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'storeFinanceAttachment', kind, detail: error.message }));
    return err('PROVIDER_ERROR', `Storage refused the upload, so nothing was saved: ${error.message}`);
  }
  return ok({ path, fileName: file.name.slice(0, 200) });
}

/** A five-minute signed URL for a stored attachment, under the reader's own session. */
export async function signFinanceAttachment(supabase: StorageClient, path: string): Promise<Result<{ url: string }>> {
  const { data, error } = await supabase.storage.from(filesBucket()).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) {
    return err('PROVIDER_ERROR', `Storage is not reachable, so the file cannot be fetched: ${error?.message ?? 'no URL was returned'}`);
  }
  return ok({ url: data.signedUrl });
}
