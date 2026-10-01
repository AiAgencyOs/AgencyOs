import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import type { StoreAttachmentInput } from '@/modules/projects/attachment-store';
import { interpretEvidence } from '@/lib/scheduler/meeting-commands-eval';

import { decideMeetingStoredFile } from './meeting-note-file';

/**
 * SCR-060 "Meeting note upload", the half round 3 added (owner decision Q-D3 of
 * 2026-10-01): a recording, an image, a PDF or a Word file is stored as it is
 * and filed as meeting evidence, "under the project-file rules" — the 50 MB
 * ceiling, the credentials guard, the project-files bucket under the tenant's
 * own folder, and a signed reference to read it back. A text file is unchanged:
 * its text stays the row's body, verbatim (`decideMeetingNoteFile`).
 *
 * Capability `lead.write`, as every other evidence door of this page; the
 * database door `crm.add_meeting_evidence_file` asks `core.can_write()` again,
 * files THROUGH `crm.add_meeting_evidence` (so the role, the tenant, the kind
 * vocabulary and the `meeting.evidence_added` audit row are the same ones
 * typed notes take) and records the object's path on the row.
 *
 * Order, so nothing pretends to have landed: the checks that need no storage;
 * the meeting is read under the caller's session (a file is never stored for a
 * meeting that is not theirs); storage is probed and the object uploaded; the
 * row is written last. Storage is imported lazily so a test that only needs the
 * pure rules never loads the storage environment.
 */

const storeAttachment = async (input: StoreAttachmentInput) =>
  (await import('@/modules/projects/attachment-store')).storeAttachment(input);

const inputSchema = z.object({ meetingId: z.uuid(), visibility: z.enum(['internal', 'client_visible']) });

export type StoredMeetingFileResult = { message: string; leadId: string | null };

export async function uploadMeetingStoredFile(
  input: { meetingId: string; visibility: string },
  file: File | null,
): Promise<Result<StoredMeetingFileResult>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid meeting, or the visibility is not internal or client-visible.');
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) return err('VALIDATION', 'Choose a file to upload.');

  const decision = decideMeetingStoredFile({ name: file.name, type: file.type, size: file.size });
  if (!decision.ok) return err('VALIDATION', decision.message);

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'Your role cannot attach meeting evidence; the owner or an ops admin can.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data: meeting, error: meetingError } = await supabase.schema('crm').from('meetings').select('id').eq('id', parsed.data.meetingId).maybeSingle();
  if (meetingError) {
    console.error(JSON.stringify({ level: 'error', scope: 'uploadMeetingStoredFile.meeting', detail: meetingError.message }));
    return err('INTERNAL', 'Could not read the meeting.');
  }
  if (!meeting) return err('NOT_FOUND', 'That meeting was not found.');

  const stored = await storeAttachment({
    supabase,
    organizationId: context.organizationId,
    area: 'meeting',
    recordId: parsed.data.meetingId,
    file,
    noun: 'meeting file',
  });
  if (!stored.ok) return stored;

  const { data, error } = await supabase.schema('crm').rpc('add_meeting_evidence_file', {
    p_meeting_id: parsed.data.meetingId,
    p_kind: decision.kind,
    p_visibility: parsed.data.visibility,
    p_storage_path: stored.data.path,
    p_file_name: stored.data.fileName,
    p_media_type: decision.mediaType,
    p_byte_size: decision.byteSize,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'uploadMeetingStoredFile.rpc', detail: `${error.message} (object ${stored.data.path} is unreferenced)` }));
    return err('INTERNAL', 'The file was stored but could not be recorded as evidence.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; lead_id?: string | null } | undefined;
  const verdict = interpretEvidence(row?.outcome);
  if (verdict.kind === 'error') return err(verdict.code, verdict.message);
  return ok({ message: `${stored.data.fileName} stored and attached to this meeting, with you as the uploader.`, leadId: row?.lead_id ?? null });
}

/** The signed reference for a stored meeting file: a five-minute URL for the evidence row's object, read under the caller's session. */
export async function resolveMeetingFileUrl(meetingId: string, evidenceId: string): Promise<Result<{ url: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(meetingId) || !/^[0-9a-f-]{36}$/i.test(evidenceId)) return err('VALIDATION', 'Invalid file.');
  const context = await requireInternal();
  if (!can(context, 'lead.read')) return err('FORBIDDEN', 'You do not have permission to read meeting evidence.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('meeting_evidence').select('storage_path').eq('id', evidenceId).eq('meeting_id', meetingId).maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolveMeetingFileUrl', detail: error.message }));
    return err('INTERNAL', 'Could not read the evidence.');
  }
  if (!data?.storage_path) return err('NOT_FOUND', 'No stored file on that evidence.');
  const { signAttachment } = await import('@/modules/projects/attachment-store');
  const signed = await signAttachment(supabase, data.storage_path);
  return signed.ok ? ok(signed.data) : signed;
}
