import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { attachmentShapeProblem } from './attachment-rules';
import type { StoreAttachmentInput } from './attachment-store';
import { ATTACHED_SUBJECT_NOUN, attachFileSchema, type AttachFileInput } from './attached-files-schema';

/**
 * Attach an uploaded file to a build, a test run or a bug — Q-C1 ("Upload
 * build" also accepts apk / ipa / zip) and Q-C6 (test-run and bug evidence may
 * be uploaded files), both "under the project-file limits and credentials
 * guard".
 *
 * Capability: a build or a bug is delivery work (`project.write`); a test run
 * is recorded by anyone who may record one (`task.write`). The database door
 * `projects.attach_file` asks again (`core.can_manage_delivery()` /
 * `core.can_write()`), re-checks the tenant, the kind of file, the 50 MB limit
 * and a credentials-looking name, and audits.
 *
 * Order: the checks that need no storage, then the subject is read under the
 * caller's session (so a file is never stored for a record that is not theirs),
 * then storage, then the row. Storage is imported lazily so nothing that only
 * needs the pure rules loads the storage environment.
 */

const storeAttachment = async (input: StoreAttachmentInput) => (await import('./attachment-store')).storeAttachment(input);

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

const SUBJECT_TABLE = {
  build: { schema: 'projects', table: 'deliverables' },
  test_run: { schema: 'qa', table: 'test_runs' },
  defect: { schema: 'qa', table: 'defects' },
} as const;

export async function attachStoredFile(input: AttachFileInput, file: File | null): Promise<Result<{ attachmentId: string; fileName: string; projectId: string }>> {
  const parsed = attachFileSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That is not something a file can be attached to.');
  const { subjectKind, subjectId } = parsed.data;
  const { noun, area } = ATTACHED_SUBJECT_NOUN[subjectKind];
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) return err('VALIDATION', 'Choose a file to upload.');
  const shape = attachmentShapeProblem({ name: file.name, size: file.size }, area);
  if (shape) return err('VALIDATION', shape);

  const context = await requireInternal();
  if (!can(context, subjectKind === 'test_run' ? 'task.write' : 'project.write')) {
    return err('FORBIDDEN', `You do not have permission to attach a ${noun}.`);
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const target = SUBJECT_TABLE[subjectKind];
  const { data: subject, error: subjectError } = await supabase.schema(target.schema).from(target.table).select('id').eq('id', subjectId).maybeSingle();
  if (subjectError) {
    log('attachStoredFile.subject', subjectError.message);
    return err('INTERNAL', 'Could not read what the file belongs to.');
  }
  if (!subject) return err('NOT_FOUND', subjectKind === 'build' ? 'Build not found.' : subjectKind === 'test_run' ? 'Test run not found.' : 'Defect not found.');

  const stored = await storeAttachment({ supabase, organizationId: context.organizationId, area, recordId: subjectId, file, noun });
  if (!stored.ok) return stored;

  const { data, error } = await supabase.schema('projects').rpc('attach_file', {
    p_subject_kind: subjectKind,
    p_subject_id: subjectId,
    p_storage_path: stored.data.path,
    p_file_name: stored.data.fileName,
    p_size_bytes: stored.data.size,
    ...(stored.data.contentType ? { p_content_type: stored.data.contentType } : {}),
  });
  if (error) {
    log('attachStoredFile.rpc', `${error.message} (object ${stored.data.path} is unreferenced)`);
    return err('INTERNAL', `The ${noun} was stored but could not be recorded.`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null; project_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'attached':
      return row.id && row.project_id ? ok({ attachmentId: row.id, fileName: stored.data.fileName, projectId: row.project_id }) : err('INTERNAL', `The ${noun} was stored but could not be recorded.`);
    case 'not_found':
      return err('NOT_FOUND', 'That record was not found.');
    case 'too_many':
      return err('CONFLICT', subjectKind === 'build' ? 'A build carries at most 5 files.' : 'A record carries at most 20 evidence files.');
    case 'too_big':
      return err('VALIDATION', 'That file is over the 50 MB limit.');
    case 'bad_type':
      return err('VALIDATION', `That is not a kind of file a ${noun} can be.`);
    case 'credential_name':
      return err('VALIDATION', 'That file’s name looks like a credentials file. Put credentials in Settings › Keys & secrets, which stores them encrypted.');
    case 'forbidden':
    case 'no_actor':
      return err('FORBIDDEN', 'The database refused: your role may not attach a file here.');
    default:
      log('attachStoredFile.outcome', `unrecognised outcome "${row?.outcome ?? 'none'}"`);
      return err('INTERNAL', `The ${noun} was stored but could not be recorded.`);
  }
}
